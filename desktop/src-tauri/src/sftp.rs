//! SFTP client — separate authenticated connection per host (model A),
//! decoupled from the interactive shell session in `ssh.rs`.
//!
//! Surface:
//! - `SftpManager` — Tauri state, map of open SFTP sessions
//! - commands: sftp_connect / sftp_realpath / sftp_list / sftp_download /
//!   sftp_upload / sftp_mkdir / sftp_rename / sftp_remove / sftp_disconnect
//!
//! v1 transfers read/write the whole file in memory (no streaming/progress
//! yet) — fine for config-sized files; large-file streaming is a follow-up.

use russh::client::{self, Handler};
use russh::keys::ssh_key::PublicKey;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ssh::{AuthMethod, ConnectArgs};

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

/// Accept any host key (TOFU not yet implemented — same posture as ssh.rs).
struct SftpHandler;

impl Handler for SftpHandler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// One open SFTP session. Keeps the russh connection handle alive alongside
/// the SFTP layer — dropping the handle would tear down the transport.
struct SftpHandle {
    sftp: SftpSession,
    _conn: client::Handle<SftpHandler>,
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
    state: State<'_, Arc<SftpManager>>,
    vault: State<'_, crate::vault::VaultState>,
    args: ConnectArgs,
) -> Result<SftpConnectResult, SftpError> {
    let addr = format!("{}:{}", args.host, args.port);
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, addr.as_str(), SftpHandler).await?;

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

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    let data = h.sftp.read(remote_path).await?;
    tokio::fs::write(&local_path, data).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, Arc<SftpManager>>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), SftpError> {
    let h = get_session(&state, &sftp_id).await?;
    let data = tokio::fs::read(&local_path).await?;
    h.sftp.write(remote_path, &data).await?;
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
