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
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
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

/// Sentinel error string returned by a transfer the user cancelled. The
/// frontend matches on this exact text to treat the rejection as a normal
/// user-cancel (no error toast) rather than a real failure.
pub const CANCELLED: &str = "cancelled";

/// Registry of transfer ids that have been asked to cancel. A transfer's chunk
/// loop checks its id once per chunk and bails (returning `CANCELLED`) when
/// present. Entries are always removed when the transfer finishes — success,
/// error, or cancel — so a later transfer that reuses an id can't be
/// mis-cancelled by a stale flag. A plain `std::sync::Mutex` is fine: the
/// critical sections are tiny and synchronous (never held across `.await`).
#[derive(Default)]
pub struct CancelRegistry {
    ids: std::sync::Mutex<HashSet<String>>,
}

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark a transfer id as cancelled.
    fn request(&self, id: &str) {
        if let Ok(mut set) = self.ids.lock() {
            set.insert(id.to_string());
        }
    }

    /// True if this id has a pending cancel request.
    fn is_cancelled(&self, id: &str) -> bool {
        self.ids
            .lock()
            .map(|set| set.contains(id))
            .unwrap_or(false)
    }

    /// Drop an id from the registry (call when the transfer ends, however it
    /// ends) so the flag can't leak into a later transfer reusing the id.
    fn clear(&self, id: &str) {
        if let Ok(mut set) = self.ids.lock() {
            set.remove(id);
        }
    }
}

/// RAII cleanup: removes the transfer id from the cancel registry on Drop, so
/// every exit path of a transfer (normal finish, `?`-propagated error, or the
/// explicit cancel return) leaves no stale flag behind.
struct CancelGuard<'a> {
    registry: &'a CancelRegistry,
    id: &'a str,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.registry.clear(self.id);
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
    // Bound the connect phase (TCP/SOCKS connect + handshake) so a dead host
    // fails fast — mirrors ssh.rs. Separate from post-connect keepalive.
    let timeout = crate::ssh::connect_timeout(args.timeout);
    let establish = async {
        if let Some(node) = &args.vpn {
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
            Ok::<_, SftpError>((session, Some(child)))
        } else {
            let addr = format!("{}:{}", args.host, args.port);
            Ok((client::connect(config, addr.as_str(), handler()).await?, None))
        }
    };
    let (mut session, xray_child) = match tokio::time::timeout(timeout, establish).await {
        Ok(res) => res?,
        Err(_) => {
            return Err(SftpError::Other(format!(
                "connection timed out after {}s",
                timeout.as_secs()
            )))
        }
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
    cancels: State<'_, Arc<CancelRegistry>>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    resume: bool,
) -> Result<(), SftpError> {
    // Make sure no stale cancel flag from a previous transfer reusing this id is
    // lingering, and always clear our own entry when we return (success / error
    // / cancel) so it can't leak into a later transfer.
    cancels.clear(&transfer_id);
    // `&**cancels`: State derefs to Arc<CancelRegistry>, which derefs to
    // CancelRegistry — deref coercion doesn't fire in struct-literal fields, so
    // deref explicitly to land on `&CancelRegistry`.
    let _guard = CancelGuard {
        registry: &**cancels,
        id: &transfer_id,
    };
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

    // When resuming, pick up after the bytes already present locally.
    let offset = if resume {
        tokio::fs::metadata(&local_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    // Already complete (a known total we've reached) → emit a final 100% and
    // return without re-opening anything.
    if offset >= total && total > 0 {
        let mut last = std::time::Instant::now();
        emit_progress(&app, &mut last, &transfer_id, total, total, "download", true);
        return Ok(());
    }

    // open() is read-only; stream chunk-by-chunk so memory stays bounded.
    let mut remote = h.sftp.open(remote_path).await?;
    // Local handle: resume → keep existing bytes and append at the offset;
    // fresh → create/truncate (identical to the non-resume behaviour).
    let mut local = if resume && offset > 0 {
        let mut f = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&local_path)
            .await?;
        f.seek(SeekFrom::Start(offset)).await?;
        remote.seek(SeekFrom::Start(offset)).await?;
        f
    } else {
        tokio::fs::File::create(&local_path).await?
    };

    let mut transferred: u64 = offset;
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut last = std::time::Instant::now();
    loop {
        // Cancellation: checked once per chunk. The `_guard` clears the registry
        // entry on return; the partial local file is left as-is (same as a
        // failed transfer — resume can pick it up, or the user overwrites).
        if cancels.is_cancelled(&transfer_id) {
            return Err(SftpError::Other(CANCELLED.to_string()));
        }
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
    cancels: State<'_, Arc<CancelRegistry>>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    resume: bool,
) -> Result<(), SftpError> {
    // Clear any stale flag and ensure our entry is removed on every exit path
    // (success / error / cancel) — see the download command for the rationale.
    cancels.clear(&transfer_id);
    // `&**cancels`: State derefs to Arc<CancelRegistry>, which derefs to
    // CancelRegistry — deref coercion doesn't fire in struct-literal fields, so
    // deref explicitly to land on `&CancelRegistry`.
    let _guard = CancelGuard {
        registry: &**cancels,
        id: &transfer_id,
    };
    let h = get_session(&state, &sftp_id).await?;
    let mut local = tokio::fs::File::open(&local_path).await?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);

    // When resuming, continue after the bytes already on the remote side.
    let offset = if resume {
        h.sftp
            .metadata(remote_path.clone())
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0)
    } else {
        0
    };

    // Already complete → emit a final 100% and return.
    if offset >= total && total > 0 {
        let mut last = std::time::Instant::now();
        emit_progress(&app, &mut last, &transfer_id, total, total, "upload", true);
        return Ok(());
    }

    // Remote handle. Fresh upload → create() (CREATE|TRUNCATE|WRITE). Resume →
    // WRITE|CREATE *without* TRUNCATE so the existing prefix is kept, then seek
    // to the offset (writes are offset-addressed, not APPEND, so this lands the
    // remainder exactly after what's already there).
    let mut remote = if resume && offset > 0 {
        let mut f = h
            .sftp
            .open_with_flags(remote_path, OpenFlags::WRITE | OpenFlags::CREATE)
            .await?;
        f.seek(SeekFrom::Start(offset)).await?;
        local.seek(SeekFrom::Start(offset)).await?;
        f
    } else {
        // NB: SftpSession::write() opens with WRITE only (no CREATE) → fails with
        // "No such file" for new files. create() uses CREATE|TRUNCATE|WRITE.
        h.sftp.create(remote_path).await?
    };

    let mut transferred: u64 = offset;
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut last = std::time::Instant::now();
    loop {
        // Cancellation: checked once per chunk. The partial remote file is left
        // as-is (same as a failed upload — resume can continue it, or overwrite).
        if cancels.is_cancelled(&transfer_id) {
            return Err(SftpError::Other(CANCELLED.to_string()));
        }
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
    // Fully commit + close the handle: shutdown drains outstanding write acks and
    // closes the remote file, guarding against a small upload not being committed
    // before the handle drops.
    remote.shutdown().await?;
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

/// Result of reading a remote file as text for the built-in viewer/editor.
#[derive(Serialize)]
pub struct SftpTextRead {
    /// UTF-8 (lossy) decoded content. Empty when `too_large` is set (we don't
    /// ship bytes the UI can't safely edit anyway).
    pub content: String,
    /// Set when we read the full `max_bytes` window but the file is larger — the
    /// `content` is the first `max_bytes` only. VIEW may still show it; EDIT must
    /// refuse (a partial save would truncate the rest of the file).
    pub truncated: bool,
    /// Set when the file's size is known to exceed `max_bytes` and we returned no
    /// content at all. EDIT must refuse.
    pub too_large: bool,
    /// Set when the read window contains NUL bytes — almost certainly binary, so
    /// the UI shows a warning instead of garbage and refuses to edit.
    pub binary: bool,
    /// Full file size in bytes (best-effort; 0 if the server didn't report it).
    pub size: u64,
}

/// Read a remote text file for the built-in viewer/editor. Reads up to
/// `max_bytes`; for a larger file we return `too_large` (no content) so EDIT
/// can refuse — the streaming `sftp_download` is the path for big files. Decodes
/// UTF-8 lossily for display and flags binary content (NUL bytes in the window).
#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
    max_bytes: u64,
) -> Result<SftpTextRead, SftpError> {
    let h = get_session(&state, &sftp_id).await?;

    // Best-effort full size for the header / too-large decision.
    let size = h
        .sftp
        .metadata(path.clone())
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);

    // Known-too-large → bail early without opening the file.
    if size > max_bytes {
        return Ok(SftpTextRead {
            content: String::new(),
            truncated: false,
            too_large: true,
            binary: false,
            size,
        });
    }

    // Read up to max_bytes + 1 so we can detect a file that grew past the limit
    // since the metadata probe (or whose size the server didn't report).
    let cap = max_bytes.saturating_add(1);
    let mut file = h.sftp.open(path).await?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; CHUNK_BYTES];
    loop {
        let n = file.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() as u64 >= cap {
            break;
        }
    }

    // More than max_bytes actually present → treat as too-large (no partial edit).
    if buf.len() as u64 > max_bytes {
        return Ok(SftpTextRead {
            content: String::new(),
            truncated: false,
            too_large: true,
            binary: false,
            size: if size == 0 { buf.len() as u64 } else { size },
        });
    }

    let binary = buf.contains(&0);
    let content = String::from_utf8_lossy(&buf).into_owned();
    Ok(SftpTextRead {
        content,
        truncated: false,
        too_large: false,
        binary,
        size: if size == 0 { buf.len() as u64 } else { size },
    })
}

/// Overwrite a remote text file with `content` (UTF-8 bytes) ATOMICALLY, never
/// truncating the live file in place.
///
/// The naive approach (open the target with CREATE|TRUNCATE then write) zeroes
/// the file the instant it's opened — so any failure of the subsequent write /
/// flush (permissions, quota, dropped connection) destroys the original and
/// leaves it empty, often silently. Instead we write a sibling temp file, verify
/// its size, then swap it into place with a rename-and-backup dance so `path`
/// always holds either the old contents or the fully-written new contents.
///
/// The temp lives in the SAME directory as the target so the rename is atomic
/// (same filesystem) and is governed by the directory's write permission. The
/// previous file mode is preserved when the server reports it.
///
/// Remote paths are POSIX, so `/` is the only separator.
///
/// Change a path's permissions WITHOUT truncating its contents.
///
/// CRITICAL: russh-sftp's `set_metadata` builds the SETSTAT request from a
/// `Metadata` via `From<&Metadata> for FileAttributes`, which ALWAYS sets
/// `size: Some(metadata.len())`. A `Metadata::default()` has len 0, so
/// `set_metadata(path, Metadata { permissions: Some(mode), ..Default::default() })`
/// sends size=0 and the SFTP server TRUNCATES the file to empty. (This silently
/// destroyed files on every editor save and every chmod.) We stat the path first
/// and reuse the real metadata — correct size/uid/gid/times — changing only the
/// permissions, so the size sent equals the current size (no truncation).
async fn set_mode_preserving(
    sftp: &SftpSession,
    path: &str,
    mode: u32,
) -> Result<(), SftpError> {
    let mut m = sftp.metadata(path.to_string()).await?;
    m.permissions = Some(mode);
    sftp.set_metadata(path.to_string(), m).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
    content: String,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;

    // Derive POSIX parent dir + basename. No '/' → file is in the (implicit)
    // current dir; use "." so the temp/backup land alongside it.
    let (dir, base) = match path.rfind('/') {
        Some(idx) => {
            let d = &path[..idx];
            let dir = if d.is_empty() { "/" } else { d };
            (dir.to_string(), path[idx + 1..].to_string())
        }
        None => (".".to_string(), path.clone()),
    };
    // Join `dir` + `name` without doubling the slash for the root dir.
    let join = |name: &str| -> String {
        if dir == "/" {
            format!("/{name}")
        } else {
            format!("{dir}/{name}")
        }
    };
    let temp = join(&format!(".{base}.nexussh-tmp"));
    let backup = join(&format!(".{base}.nexussh-bak"));

    // Best-effort cleanup of any stale temp from a previous aborted save —
    // open_with_flags(...TRUNCATE) would handle a leftover anyway, but removing
    // it keeps perms/ownership from leaking across saves.
    let _ = h.sftp.remove_file(temp.clone()).await;

    // Stat the target once: tells us whether it already exists (so we know
    // whether to back it up before the swap) and captures its mode (None if the
    // file is new or the server doesn't report perms). The mode is reapplied to
    // the temp before the swap so perms survive the rename.
    let orig_meta = h.sftp.metadata(path.clone()).await.ok();
    let original_exists = orig_meta.is_some();
    let prev_mode = orig_meta.and_then(|m| m.permissions);

    // 1) Write the full content to the temp file and close it cleanly.
    //    shutdown() drains outstanding write acks AND closes the handle, which is
    //    stronger than flush()+drop for ensuring the bytes are committed.
    {
        let mut file = h
            .sftp
            .open_with_flags(
                temp.clone(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| {
                SftpError::Other(format!("creating temp file {temp}: {e}"))
            })?;
        if let Err(e) = file.write_all(content.as_bytes()).await {
            drop(file);
            let _ = h.sftp.remove_file(temp.clone()).await;
            return Err(SftpError::Other(format!(
                "writing temp file {temp}: {e}"
            )));
        }
        if let Err(e) = file.shutdown().await {
            drop(file);
            let _ = h.sftp.remove_file(temp.clone()).await;
            return Err(SftpError::Other(format!(
                "closing temp file {temp}: {e}"
            )));
        }
        drop(file);
    }

    // 2) Verify: re-stat the temp and confirm the byte count matches. A
    //    partial/failed write is reported here and the temp removed — never
    //    silently committed over the original.
    let want = content.as_bytes().len() as u64;
    let got = h
        .sftp
        .metadata(temp.clone())
        .await
        .map_err(|e| SftpError::Other(format!("stat temp file {temp}: {e}")))?
        .size
        .unwrap_or(0);
    if got != want {
        let _ = h.sftp.remove_file(temp.clone()).await;
        return Err(SftpError::Other(format!(
            "write verification failed: wrote {got} of {want} bytes"
        )));
    }

    // 3) Preserve the original mode on the temp (best-effort — a chmod failure
    //    doesn't endanger the content, so don't abort the save over it).
    if let Some(mode) = prev_mode {
        // best-effort — a chmod failure doesn't endanger the content
        let _ = set_mode_preserving(&h.sftp, &temp, mode).await;
    }

    // 4) Swap the temp into place. russh-sftp's rename (FXP_RENAME) fails when the
    //    destination exists on OpenSSH, so the original is first moved aside to a
    //    backup; `path` is then never left missing for longer than one rename and
    //    is always restorable if the final rename fails.
    if original_exists {
        let _ = h.sftp.remove_file(backup.clone()).await; // clear stale backup
        h.sftp
            .rename(path.clone(), backup.clone())
            .await
            .map_err(|e| {
                SftpError::Other(format!(
                    "backing up original {path} -> {backup}: {e}"
                ))
            })?;

        if let Err(e) = h.sftp.rename(temp.clone(), path.clone()).await {
            // Final swap failed — restore the user's original and clean up so the
            // file is exactly as it was before this save.
            let _ = h.sftp.rename(backup.clone(), path.clone()).await;
            let _ = h.sftp.remove_file(temp.clone()).await;
            return Err(SftpError::Other(format!(
                "committing {temp} -> {path}: {e}"
            )));
        }
        // New content is live; drop the backup (best-effort).
        let _ = h.sftp.remove_file(backup).await;
    } else {
        // New file: no original to protect, just move the temp into place.
        if let Err(e) = h.sftp.rename(temp.clone(), path.clone()).await {
            let _ = h.sftp.remove_file(temp.clone()).await;
            return Err(SftpError::Other(format!(
                "committing {temp} -> {path}: {e}"
            )));
        }
    }

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
    set_mode_preserving(&h.sftp, &path, mode).await?;
    Ok(())
}

/// Recursively chmod a directory tree: applies `mode` to `path` and everything
/// beneath it. Traversal is iterative (explicit stack of dirs to visit) so a
/// very deep tree can't blow the call stack.
///
/// Symlinks: the entry's mode is set on the link itself (the same `set_metadata`
/// the non-recursive command uses — SFTP has no lchmod, and on most servers
/// chmod of a symlink path affects the link target's perms only if the server
/// follows it; russh-sftp issues SSH_FXP_SETSTAT which is server-defined). We
/// deliberately do NOT descend INTO a symlinked directory — only real
/// subdirectories (reported by the server's file-type) are pushed onto the
/// traversal stack, so we never wander out of the tree via a link.
///
/// Returns the number of entries touched (the root dir plus every descendant).
#[tauri::command]
pub async fn sftp_chmod_recursive(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    path: String,
    mode: u32,
) -> Result<u64, SftpError> {
    let h = get_session(&state, &sftp_id).await?;

    let set_mode = |p: String| {
        let sftp = &h.sftp;
        async move { set_mode_preserving(sftp, &p, mode).await }
    };

    // Apply to the root directory itself first.
    set_mode(path.clone()).await?;
    let mut touched: u64 = 1;

    // Iterative DFS over real subdirectories only.
    let mut stack: Vec<String> = vec![path];
    while let Some(dir) = stack.pop() {
        let entries = h.sftp.read_dir(dir.clone()).await?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = if dir.ends_with('/') {
                format!("{dir}{name}")
            } else {
                format!("{dir}/{name}")
            };
            let ft = entry.file_type();
            // chmod the entry (link itself for symlinks — we don't follow them).
            set_mode(child.clone()).await?;
            touched += 1;
            // Descend only into REAL directories, never through symlinks, so we
            // can't escape the original tree.
            if ft.is_dir() && !ft.is_symlink() {
                stack.push(child);
            }
        }
    }

    Ok(touched)
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
    if !is_dir {
        h.sftp.remove_file(path).await?;
        return Ok(());
    }

    // Recursive directory delete. SFTP rmdir fails on a non-empty directory, so
    // we must clear the tree first. Traversal is iterative (explicit stack) so a
    // very deep tree can't blow the call stack.
    //
    // We walk the tree top-down, removing files (and symlinks — including links
    // that point at directories) as we go and recording every REAL subdirectory
    // in `dirs` in discovery order. Then we remove the directories deepest-first
    // (reverse discovery order) so each is empty by the time we rmdir it.
    //
    // Symlinks are deleted with remove_file (the link entry itself) and never
    // descended into, so we can't wander out of the original tree via a link.
    let mut dirs: Vec<String> = vec![path.clone()];
    let mut stack: Vec<String> = vec![path];
    while let Some(dir) = stack.pop() {
        let entries = h.sftp.read_dir(dir.clone()).await?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = if dir.ends_with('/') {
                format!("{dir}{name}")
            } else {
                format!("{dir}/{name}")
            };
            let ft = entry.file_type();
            if ft.is_dir() && !ft.is_symlink() {
                // Real subdirectory: record it and descend.
                dirs.push(child.clone());
                stack.push(child);
            } else {
                // File, or a symlink (even one pointing at a directory): unlink
                // the entry itself without following it.
                h.sftp.remove_file(child).await?;
            }
        }
    }

    // Now every directory is empty of files; remove deepest-first.
    while let Some(dir) = dirs.pop() {
        h.sftp.remove_dir(dir).await?;
    }
    Ok(())
}

/// Ask a running transfer to stop. The transfer's chunk loop notices the flag
/// on its next iteration, cleans up, and rejects with the `CANCELLED` sentinel.
/// A no-op if the id isn't currently transferring.
#[tauri::command]
pub fn sftp_cancel(state: State<'_, Arc<CancelRegistry>>, id: String) {
    state.request(&id);
}

#[tauri::command]
pub async fn sftp_disconnect(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
) -> Result<(), SftpError> {
    state.sessions.lock().await.remove(&sftp_id);
    Ok(())
}
