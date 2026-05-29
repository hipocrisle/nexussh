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
    /// Resolve credential at runtime from an external secret manager.
    /// `key` is the path the manager will look up (e.g. `tggrep.bot_token` for
    /// our vault CLI). For now we treat the resolved secret as a password.
    #[serde(rename = "vault")]
    Vault { key: String },
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
    /// When set, route the SSH TCP connection through a local xray SOCKS proxy
    /// egressing via this VPN node (built-in transport). The frontend resolves
    /// the chosen profile+exit into a node and passes it here.
    #[serde(default)]
    pub vpn: Option<crate::vpn::VpnNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectResult {
    pub session_id: String,
}

/// Per-session output gate. Frontend's `listen('ssh-data', ...)` is async
/// — if the server sends a banner before the JS listener finishes
/// attaching, those bytes are lost (terminal stays blank even though the
/// connection succeeded; the .cast file still has them since the logger
/// runs in-process). Backend therefore buffers `ssh-data` payloads until
/// the frontend calls `ssh_ready`, then flushes and switches to direct
/// emit.
enum OutputGate {
    Buffering(Vec<Vec<u8>>),
    Ready,
}

/// One active SSH session.
struct ActiveSession {
    /// Channel handle for sending data/resize to server.
    sender: mpsc::UnboundedSender<SessionCommand>,
    /// Output gate (see `OutputGate`). Shared with the session loop task.
    gate: Arc<Mutex<OutputGate>>,
    /// Bundled xray proxy backing this session's transport (built-in VPN).
    /// Held here so it's killed (kill_on_drop) when the session is removed.
    _xray: Option<tokio::process::Child>,
}

use crate::history::SessionLogger;

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

/// Grab an ephemeral free localhost port for the xray SOCKS inbound.
fn free_local_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Poll the local SOCKS port until xray accepts connections (or time out).
async fn wait_socks_ready(port: u16) -> Result<(), SshError> {
    for _ in 0..60 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(SshError::Other("xray SOCKS proxy did not come up in time".into()))
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, Arc<SessionManager>>,
    vault: State<'_, crate::vault::VaultState>,
    args: ConnectArgs,
) -> Result<ConnectResult, SshError> {
    let session_id = Uuid::new_v4().to_string();
    // Keepalive keeps the tunnel warm so idle middleboxes (e.g. a WS proxy in
    // front of a VPN entry) don't close an idle session. keepalive_max = 0 is
    // critical for VPN-tunnelled sessions: a high-latency / lossy cascade can
    // delay or drop keepalive replies, and with a non-zero max russh would
    // force-disconnect after that many unanswered keepalives (KeepaliveTimeout)
    // — the real cause of variable VPN drops. With 0, we never proactively
    // disconnect; a truly dead link is still caught when the TCP socket closes.
    let mut cfg = client::Config::default();
    cfg.keepalive_interval = Some(std::time::Duration::from_secs(20));
    cfg.keepalive_max = 0;
    let config = Arc::new(cfg);

    // Establish the transport stream: either a direct TCP connect, or — when
    // the host is flagged "via built-in VPN" — through a local xray SOCKS5
    // proxy that egresses via the chosen node (userspace, no TUN/admin).
    let (mut session, xray_child) = if let Some(node) = &args.vpn {
        let socks_port = free_local_port()?;
        let child = crate::vpn::spawn_xray(node, socks_port)
            .map_err(|e| SshError::Other(format!("xray spawn: {e}")))?;
        wait_socks_ready(socks_port).await?;
        let proxy = format!("127.0.0.1:{socks_port}");
        let stream = tokio_socks::tcp::Socks5Stream::connect(
            proxy.as_str(),
            (args.host.as_str(), args.port),
        )
        .await
        .map_err(|e| SshError::Other(format!("socks connect: {e}")))?;
        let session =
            client::connect_stream(config, stream.into_inner(), AcceptAllHandler).await?;
        (session, Some(child))
    } else {
        let addr = format!("{}:{}", args.host, args.port);
        let session = client::connect(config, addr.as_str(), AcceptAllHandler).await?;
        (session, None)
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
            // Resolve secret from our in-memory vault (must be unlocked).
            let secret = crate::vault::resolve(&vault, key)
                .map_err(|e| SshError::Other(e.to_string()))?;
            session
                .authenticate_password(&args.user, &secret)
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
    let gate = Arc::new(Mutex::new(OutputGate::Buffering(Vec::new())));
    state.sessions.lock().await.insert(
        session_id.clone(),
        ActiveSession {
            sender: tx.clone(),
            gate: gate.clone(),
            _xray: xray_child,
        },
    );

    // Open per-session log file for history.
    // Failure to open the log is non-fatal — we still let the user connect.
    let logger = SessionLogger::open(
        &app,
        &session_id,
        &args.host,
        args.port,
        &args.user,
        cols,
        rows,
    )
    .ok()
    .map(Arc::new);

    let sid = session_id.clone();
    let app_handle = app.clone();
    let manager = state.inner().clone();

    tokio::spawn(async move {
        let close_reason = run_session_loop(
            &app_handle,
            &sid,
            &mut channel,
            &mut rx,
            session,
            logger.as_deref(),
            gate,
        )
        .await;
        if let Some(l) = logger.as_ref() {
            l.finalize();
        }
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
    logger: Option<&SessionLogger>,
    gate: Arc<Mutex<OutputGate>>,
) -> String {
    // Emit-or-buffer for ssh-data. Atomic under the gate Mutex so that
    // `ssh_ready` either sees this push (and flushes it) or runs first
    // and we hit the Ready branch — no event is lost between them.
    async fn ship(
        app: &AppHandle,
        sid: &str,
        gate: &Mutex<OutputGate>,
        bytes: Vec<u8>,
    ) {
        let mut g = gate.lock().await;
        match &mut *g {
            OutputGate::Buffering(buf) => buf.push(bytes),
            OutputGate::Ready => {
                drop(g);
                let _ = app.emit(
                    "ssh-data",
                    DataEvent {
                        session_id: sid.to_string(),
                        data: bytes,
                    },
                );
            }
        }
    }

    // Explicit application-level keepalive. russh's built-in client keepalive
    // timer didn't keep VPN-tunnelled (WS-proxied) sessions alive in practice,
    // so we drive it ourselves: every 25s send keepalive@openssh.com (want_reply)
    // via the Handle's Msg channel — the server's reply generates bidirectional
    // traffic that resets the WS proxy's ~60s idle timeout. Harmless for direct
    // sessions too. First tick is immediate; consume it so we don't fire at t=0.
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(25));
    keepalive.tick().await;

    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                let _ = session.send_keepalive(true).await;
            }
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
                        if let Some(l) = logger { l.append(&data); }
                        ship(app, sid, &gate, data.to_vec()).await;
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        // stderr arrives here in some shells; merge into the same stream
                        if let Some(l) = logger { l.append(&data); }
                        ship(app, sid, &gate, data.to_vec()).await;
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

/// Signal that the frontend's `listen('ssh-data')` handler is attached and
/// ready to receive events. Backend flushes any buffered output through
/// the same `ssh-data` channel, then switches to direct emit. Idempotent.
#[tauri::command]
pub async fn ssh_ready(
    app: AppHandle,
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), SshError> {
    let gate = {
        let sessions = state.sessions.lock().await;
        let s = sessions
            .get(&session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
        s.gate.clone()
    };
    let mut g = gate.lock().await;
    let buffered = match std::mem::replace(&mut *g, OutputGate::Ready) {
        OutputGate::Buffering(v) => v,
        OutputGate::Ready => return Ok(()),
    };
    drop(g);
    for bytes in buffered {
        let _ = app.emit(
            "ssh-data",
            DataEvent {
                session_id: session_id.clone(),
                data: bytes,
            },
        );
    }
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
