//! SFTP client — separate authenticated connection per host (model A),
//! decoupled from the interactive shell session in `ssh.rs`.
//!
//! Surface:
//! - `SftpManager` — Tauri state, map of open SFTP sessions
//! - commands: sftp_connect / sftp_realpath / sftp_list / sftp_download /
//!   sftp_upload / sftp_mkdir / sftp_rename / sftp_remove / sftp_disconnect
//!
//! v2 transfers stream in fixed-size chunks (no whole-file buffering) and emit
//! `sftp-progress` events so the UI can show a progress bar — large files work
//! without OOM since only one chunk is held at a time.

use russh::client::{self};
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ssh::{known_hosts_path, AuthMethod, ConnectArgs, TofuHandler};

/// Streaming chunk size — keeps peak memory bounded regardless of file size.
const CHUNK_BYTES: usize = 64 * 1024;

/// Progress events are throttled to at most one per this interval so a fast
/// transfer doesn't flood the event loop (a final 100% event is always sent).
const PROGRESS_INTERVAL_MS: u128 = 150;

#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error("ssh protocol: {0}")]
    Russh(#[from] russh::Error),
    #[error("ssh keys: {0}")]
    RusshKeys(#[from] russh::keys::Error),
    #[error("sftp: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("auth failed")]
    AuthFailed,
    #[error("sftp session {0} not found")]
    SessionNotFound(String),
    #[error("other: {0}")]
    Other(String),
}

impl serde::Serialize for SftpError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// One open SFTP session. Keeps the russh connection handle alive alongside
/// the SFTP layer — dropping the handle would tear down the transport.
struct SftpHandle {
    sftp: SftpSession,
    _conn: client::Handle<TofuHandler>,
    /// xray child for VPN-routed SFTP — kill_on_drop tears the proxy down with
    /// the session.
    _xray: Option<tokio::process::Child>,
}

#[derive(Default)]
pub struct SftpManager {
    sessions: Mutex<HashMap<String, Arc<SftpHandle>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize)]
pub struct SftpConnectResult {
    pub sftp_id: String,
}

#[derive(Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix mtime in seconds (0 if unknown).
    pub mtime: u64,
    /// POSIX mode bits (0 if unknown).
    pub permissions: u32,
    /// Owner user name if the server reports it (else empty).
    pub owner: String,
    /// Numeric uid (0 if unknown).
    pub uid: u32,
}

async fn get_session(
    state: &State<'_, Arc<SftpManager>>,
    sftp_id: &str,
) -> Result<Arc<SftpHandle>, SftpError> {
    let map = state.sessions.lock().await;
    map.get(sftp_id)
        .cloned()
        .ok_or_else(|| SftpError::SessionNotFound(sftp_id.to_string()))
}

#[tauri::command]
pub async fn sftp_connect(
    app: AppHandle,
    state: State<'_, Arc<SftpManager>>,
    vault: State<'_, crate::vault::VaultState>,
    args: ConnectArgs,
) -> Result<SftpConnectResult, SftpError> {
    // Legacy algorithms only when the host opted in (mirror ssh.rs), so SFTP to
    // a modern host can't be downgraded.
    let config = Arc::new({
        let mut c = client::Config::default();
        c.preferred = crate::ssh::preferred_for(args.allow_legacy);
        c
    });

    // Same TOFU host-key verification as the shell side — both transports share
    // one known_hosts.json so a key trusted on the shell is enforced for SFTP
    // (and a changed key is refused on either).
    let handler = || TofuHandler {
        host: args.host.clone(),
        port: args.port,
        store_path: known_hosts_path(&app),
        app: app.clone(),
        use_vault: args.encrypt_known_hosts,
    };

    // Route through the built-in VPN (xray SOCKS) when the host is flagged,
    // mirroring ssh.rs — otherwise a VPN-only host can't open files.
    let (mut session, xray_child) = if let Some(node) = &args.vpn {
        let socks_port = crate::ssh::free_local_port()?;
        let child = crate::vpn::spawn_xray(node, socks_port)
            .map_err(|e| SftpError::Other(format!("xray spawn: {e}")))?;
        crate::ssh::wait_socks_ready(socks_port)
            .await
            .map_err(|e| SftpError::Other(e.to_string()))?;
        let proxy = format!("127.0.0.1:{socks_port}");
        let stream = crate::ssh::socks_connect_with_retry(
            proxy.as_str(),
            &args.host,
            args.port,
        )
        .await
        .map_err(|e| SftpError::Other(format!("socks connect: {e}")))?;
        let session =
            client::connect_stream(config, stream.into_inner(), handler()).await?;
        (session, Some(child))
    } else {
        let addr = format!("{}:{}", args.host, args.port);
        (client::connect(config, addr.as_str(), handler()).await?, None)
    };

    let auth_ok = match &args.auth {
        AuthMethod::Password { password } => session
            .authenticate_password(&args.user, password)
            .await?
            .success(),
        AuthMethod::Key { path, passphrase } => {
            let key = russh::keys::load_secret_key(path, passphrase.as_deref())?;
            session
                .authenticate_publickey(
                    &args.user,
                    russh::keys::PrivateKeyWithHashAlg::new(
                        Arc::new(key),
                        session.best_supported_rsa_hash().await?.flatten(),
                    ),
                )
                .await?
                .success()
        }
        AuthMethod::Vault { key } => {
            let secret = crate::vault::resolve(&vault, key)
                .map_err(|e| SftpError::Other(e.to_string()))?;
            session
                .authenticate_password(&args.user, &secret)
                .await?
                .success()
        }
    };
    if !auth_ok {
        return Err(SftpError::AuthFailed);
    }

    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;

    let sftp_id = Uuid::new_v4().to_string();
    state.sessions.lock().await.insert(
        sftp_id.clone(),
        Arc::new(SftpHandle {
            sftp,
            _conn: session,
            _xray: xray_child,
        }),
    );
    Ok(SftpConnectResult { sftp_id })
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
) -> Result<String, SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    Ok(h.sftp.canonicalize(path).await?)
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    let mut out = Vec::new();
    for entry in h.sftp.read_dir(path).await? {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let ft = entry.file_type();
        out.push(SftpEntry {
            name,
            is_dir: ft.is_dir(),
            is_symlink: ft.is_symlink(),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.unwrap_or(0) as u64,
            permissions: meta.permissions.unwrap_or(0),
            owner: meta.user.clone().unwrap_or_default(),
            uid: meta.uid.unwrap_or(0),
        });
    }
    // Dirs first, then alphabetical (case-insensitive).
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Emit a throttled `sftp-progress` event. `last` tracks the wall-clock of the
/// previous emit; pass `force = true` for the terminal (100%) event so it is
/// never dropped by the throttle.
fn emit_progress(
    app: &AppHandle,
    last: &mut std::time::Instant,
    transfer_id: &str,
    transferred: u64,
    total: u64,
    phase: &str,
    force: bool,
) {
    if !force && last.elapsed().as_millis() < PROGRESS_INTERVAL_MS {
        return;
    }
    *last = std::time::Instant::now();
    let _ = app.emit(
        "sftp-progress",
        json!({
            "id": transfer_id,
            "transferred": transferred,
            "total": total,
            "phase": phase,
        }),
    );
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    // Best-effort total for the progress bar; 0 means "unknown" (UI shows an
    // indeterminate / byte-count state).
    let total = h
        .sftp
        .metadata(remote_path.clone())
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);

    // open() is read-only; stream chunk-by-chunk so memory stays bounded.
    let mut remote = h.sftp.open(remote_path).await?;
    let mut local = tokio::fs::File::create(&local_path).await?;

    let mut transferred: u64 = 0;
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut last = std::time::Instant::now();
    loop {
        let n = remote.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await?;
        transferred += n as u64;
        emit_progress(
            &app, &mut last, &transfer_id, transferred, total, "download", false,
        );
    }
    local.flush().await?;
    emit_progress(
        &app,
        &mut last,
        &transfer_id,
        transferred,
        if total == 0 { transferred } else { total },
        "download",
        true,
    );
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    let mut local = tokio::fs::File::open(&local_path).await?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);

    // NB: SftpSession::write() opens with WRITE only (no CREATE) → fails with
    // "No such file" for new files. create() uses CREATE|TRUNCATE|WRITE.
    let mut remote = h.sftp.create(remote_path).await?;

    let mut transferred: u64 = 0;
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut last = std::time::Instant::now();
    loop {
        let n = local.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        remote.write_all(&buf[..n]).await?;
        transferred += n as u64;
        emit_progress(
            &app, &mut last, &transfer_id, transferred, total, "upload", false,
        );
    }
    remote.flush().await?;
    emit_progress(
        &app,
        &mut last,
        &transfer_id,
        transferred,
        if total == 0 { transferred } else { total },
        "upload",
        true,
    );
    Ok(())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
    mode: u32,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    h.sftp
        .set_metadata(
            path,
            Metadata {
                permissions: Some(mode),
                ..Default::default()
            },
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    h.sftp.create_dir(path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    from: String,
    to: String,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    h.sftp.rename(from, to).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    if is_dir {
        h.sftp.remove_dir(path).await?;
    } else {
        h.sftp.remove_file(path).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
) -> Result<(), SftpError> {
    state.sessions.lock().await.remove(&sftp_id);
    Ok(())
}
