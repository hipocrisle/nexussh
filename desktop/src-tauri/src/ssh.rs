//! SSH session manager — wraps russh into Tauri-friendly commands + events.
//!
//! Public surface:
//! - `SessionManager` — Tauri-managed state with a map of active sessions
//! - Tauri commands: `ssh_connect`, `ssh_send`, `ssh_resize`, `ssh_disconnect`
//! - Tauri event "ssh-data" emitted as raw bytes arrive from server
//!   payload: { session_id: String, data: Vec<u8> }
//! - Tauri event "ssh-closed" payload: { session_id, reason }
//!
//! Auth (Phase 1): password OR private key file. Key-passphrase + agent later.

use russh::client::{self, Handler};
use russh::keys::ssh_key::PublicKey;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("ssh protocol: {0}")]
    Russh(#[from] russh::Error),
    #[error("ssh keys: {0}")]
    RussshKeys(#[from] russh::keys::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("auth failed")]
    AuthFailed,
    #[error("session {0} not found")]
    SessionNotFound(String),
    #[error("invalid host:port")]
    InvalidAddr,
    #[error("other: {0}")]
    Other(String),
}

impl serde::Serialize for SshError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum AuthMethod {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "key")]
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectArgs {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    /// Optional terminal size
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectResult {
    pub session_id: String,
}

/// One active SSH session.
struct ActiveSession {
    /// Channel handle for sending data/resize to server.
    sender: mpsc::UnboundedSender<SessionCommand>,
}

enum SessionCommand {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Disconnect,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, ActiveSession>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Trust all server keys for now. TODO: TOFU with persistent known_hosts.
struct AcceptAllHandler;

impl Handler for AcceptAllHandler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, Arc<SessionManager>>,
    args: ConnectArgs,
) -> Result<ConnectResult, SshError> {
    let session_id = Uuid::new_v4().to_string();
    let addr = format!("{}:{}", args.host, args.port);

    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, addr.as_str(), AcceptAllHandler).await?;

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
    };
    if !auth_ok {
        return Err(SshError::AuthFailed);
    }

    let mut channel = session.channel_open_session().await?;
    let cols = args.cols.unwrap_or(80);
    let rows = args.rows.unwrap_or(24);
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<SessionCommand>();
    state.sessions.lock().await.insert(
        session_id.clone(),
        ActiveSession {
            sender: tx.clone(),
        },
    );

    let sid = session_id.clone();
    let app_handle = app.clone();
    let manager = state.inner().clone();

    tokio::spawn(async move {
        let close_reason = run_session_loop(&app_handle, &sid, &mut channel, &mut rx, session).await;
        manager.sessions.lock().await.remove(&sid);
        let _ = app_handle.emit(
            "ssh-closed",
            ClosedEvent {
                session_id: sid,
                reason: close_reason,
            },
        );
    });

    Ok(ConnectResult { session_id })
}

#[derive(Clone, Serialize)]
struct DataEvent {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct ClosedEvent {
    session_id: String,
    reason: String,
}

async fn run_session_loop(
    app: &AppHandle,
    sid: &str,
    channel: &mut russh::Channel<client::Msg>,
    rx: &mut mpsc::UnboundedReceiver<SessionCommand>,
    session: client::Handle<AcceptAllHandler>,
) -> String {
    loop {
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { return "channel closed".into(); };
                match cmd {
                    SessionCommand::Data(bytes) => {
                        if let Err(e) = channel.data(bytes.as_slice()).await {
                            return format!("send error: {e}");
                        }
                    }
                    SessionCommand::Resize { cols, rows } => {
                        if let Err(e) = channel.window_change(cols as u32, rows as u32, 0, 0).await {
                            return format!("resize error: {e}");
                        }
                    }
                    SessionCommand::Disconnect => {
                        let _ = channel.eof().await;
                        let _ = session.disconnect(Disconnect::ByApplication, "user closed", "en").await;
                        return "user disconnected".into();
                    }
                }
            }
            msg = channel.wait() => {
                let Some(msg) = msg else { return "server closed channel".into(); };
                match msg {
                    ChannelMsg::Data { data } => {
                        let _ = app.emit("ssh-data", DataEvent {
                            session_id: sid.to_string(),
                            data: data.to_vec(),
                        });
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        // stderr arrives here in some shells; merge into the same stream
                        let _ = app.emit("ssh-data", DataEvent {
                            session_id: sid.to_string(),
                            data: data.to_vec(),
                        });
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        return format!("exit status {exit_status}");
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => {
                        return "channel eof/close".into();
                    }
                    _ => {}
                }
            }
        }
    }
}

#[tauri::command]
pub async fn ssh_send(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), SshError> {
    let sessions = state.sessions.lock().await;
    let s = sessions
        .get(&session_id)
        .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
    s.sender
        .send(SessionCommand::Data(data))
        .map_err(|e| SshError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), SshError> {
    let sessions = state.sessions.lock().await;
    let s = sessions
        .get(&session_id)
        .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
    s.sender
        .send(SessionCommand::Resize { cols, rows })
        .map_err(|e| SshError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), SshError> {
    let sessions = state.sessions.lock().await;
    let s = sessions
        .get(&session_id)
        .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
    let _ = s.sender.send(SessionCommand::Disconnect);
    Ok(())
}
