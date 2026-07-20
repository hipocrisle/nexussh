//! Local port forwarding — the `ssh -L localPort:remoteHost:remotePort` feature.
//!
//! Model mirrors `sftp.rs`: a tunnel is its own authenticated SSH connection
//! (independent of any interactive shell tab), reusing the shell's auth/vault,
//! host-key TOFU, legacy-algorithm policy and per-host built-in VPN (xray SOCKS).
//!
//! A local `TcpListener` on 127.0.0.1:localPort accepts connections; each one
//! opens a `direct-tcpip` channel to remoteHost:remotePort on the server and is
//! spliced bidirectionally. So pointing a browser at `localhost:localPort`
//! reaches a service bound only on the remote box (e.g. a blocked admin panel).

use russh::client::{self};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ssh::{known_hosts_path, AuthMethod, ConnectArgs, TofuHandler};

#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("ssh protocol: {0}")]
    Russh(#[from] russh::Error),
    #[error("ssh keys: {0}")]
    RusshKeys(#[from] russh::keys::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("auth failed")]
    AuthFailed,
    #[error("local port {0} is busy: {1}")]
    Bind(u16, String),
    #[error("tunnel {0} not found")]
    NotFound(String),
    #[error("other: {0}")]
    Other(String),
}

impl serde::Serialize for TunnelError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Public view of an active tunnel (sent to the frontend Tunnels panel).
#[derive(Serialize, Clone)]
pub struct TunnelInfo {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// Host display label (for the panel).
    pub label: String,
}

struct TunnelHandle {
    info: TunnelInfo,
    /// Accept loop — aborted on close, which drops the listener (frees the port).
    accept_task: tokio::task::JoinHandle<()>,
    /// Per-connection forwarding tasks. Aborting the accept loop only stops NEW
    /// connections; already-established ones (e.g. a browser keep-alive socket)
    /// keep forwarding until torn down. On close we abort these too so "Stop"
    /// actually kills live sessions, not just blocks new ones.
    conn_tasks: Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    /// Keep the SSH transport alive for the tunnel's lifetime.
    _conn: Arc<client::Handle<TofuHandler>>,
    /// Transport backing this forward (xray sidecar, shared corp-VPN tunnel
    /// reference, or none) — torn down / released when the forward is dropped.
    _transport: crate::vpn::TransportHold,
}

#[derive(Default)]
pub struct TunnelManager {
    sessions: Mutex<HashMap<String, TunnelHandle>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Authenticate a dedicated SSH connection for the tunnel (mirrors sftp.rs).
async fn connect_and_auth(
    app: &AppHandle,
    vault: &State<'_, crate::vault::VaultState>,
    args: &ConnectArgs,
) -> Result<(client::Handle<TofuHandler>, crate::vpn::TransportHold), TunnelError> {
    let config = Arc::new({
        let mut c = client::Config::default();
        c.preferred = crate::ssh::preferred_for(args.allow_legacy);
        // Tunnels sit idle waiting for browser connections — keep the transport
        // warm so the server doesn't drop it before the panel is opened. The
        // user's keepalive setting overrides the 30s idle-tunnel default when
        // set; 0/absent keeps today's 30s behavior. keepalive_max stays 3.
        c.keepalive_interval = Some(if args.keepalive == 0 {
            Duration::from_secs(30)
        } else {
            Duration::from_secs(args.keepalive)
        });
        c.keepalive_max = 3;
        c
    });
    let handler = || TofuHandler {
        host: args.host.clone(),
        port: args.port,
        store_path: known_hosts_path(app),
        app: app.clone(),
        use_vault: args.encrypt_known_hosts,
        pending: std::sync::Arc::new(std::sync::Mutex::new(None)),
    };

    // Bound the connect phase (TCP/SOCKS connect + handshake) so a dead host
    // fails fast — mirrors ssh.rs/sftp.rs. Separate from post-connect keepalive.
    let timeout = crate::ssh::connect_timeout(args.timeout);
    let establish = async {
        if let Some(corp) = &args.corp_vpn {
            let guard = crate::vpn::acquire_tunnel(app, &corp.profile, &corp.password)
                .await
                .map_err(TunnelError::Other)?;
            let proxy = format!("127.0.0.1:{}", guard.socks_port);
            let stream =
                crate::ssh::socks_connect_with_retry(proxy.as_str(), &args.host, args.port)
                    .await
                    .map_err(|e| TunnelError::Other(format!("socks connect: {e}")))?;
            let session =
                client::connect_stream(config, stream.into_inner(), handler()).await?;
            Ok::<_, TunnelError>((session, crate::vpn::TransportHold::Corp(guard)))
        } else if let Some(node) = &args.vpn {
            let socks_port = crate::ssh::free_local_port()?;
            let child = crate::vpn::spawn_xray(node, socks_port)
                .map_err(|e| TunnelError::Other(format!("xray spawn: {e}")))?;
            crate::ssh::wait_socks_ready(socks_port)
                .await
                .map_err(|e| TunnelError::Other(e.to_string()))?;
            let proxy = format!("127.0.0.1:{socks_port}");
            let stream =
                crate::ssh::socks_connect_with_retry(proxy.as_str(), &args.host, args.port)
                    .await
                    .map_err(|e| TunnelError::Other(format!("socks connect: {e}")))?;
            let session =
                client::connect_stream(config, stream.into_inner(), handler()).await?;
            Ok::<_, TunnelError>((session, crate::vpn::TransportHold::Xray(child)))
        } else {
            let addr = format!("{}:{}", args.host, args.port);
            Ok((
                client::connect(config, addr.as_str(), handler()).await?,
                crate::vpn::TransportHold::None,
            ))
        }
    };
    let (mut session, transport_hold) = match tokio::time::timeout(timeout, establish).await {
        Ok(res) => res?,
        Err(_) => {
            return Err(TunnelError::Other(format!(
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
        AuthMethod::Key { path, passphrase, content } => {
            let key = match content.as_deref().filter(|s| !s.trim().is_empty()) {
                Some(text) => russh::keys::decode_secret_key(text, passphrase.as_deref())?,
                None => russh::keys::load_secret_key(path, passphrase.as_deref())?,
            };
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
            let secret = crate::vault::resolve(vault, key)
                .map_err(|e| TunnelError::Other(e.to_string()))?;
            session
                .authenticate_password(&args.user, &secret)
                .await?
                .success()
        }
    };
    if !auth_ok {
        return Err(TunnelError::AuthFailed);
    }
    Ok((session, transport_hold))
}

#[tauri::command]
pub async fn ssh_tunnel_open(
    app: AppHandle,
    state: State<'_, Arc<TunnelManager>>,
    vault: State<'_, crate::vault::VaultState>,
    args: ConnectArgs,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    label: String,
) -> Result<TunnelInfo, TunnelError> {
    let (session, transport_hold) = connect_and_auth(&app, &vault, &args).await?;
    let conn = Arc::new(session);

    // Bind the local listener BEFORE returning, so a busy port surfaces as a
    // clear error to the user (not a silent dead tunnel). 0 → OS picks a port.
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| TunnelError::Bind(local_port, e.to_string()))?;
    let actual_port = listener.local_addr()?.port();

    let conn_accept = conn.clone();
    let rhost = remote_host.clone();
    let conn_tasks: Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let conn_tasks_accept = conn_tasks.clone();
    let accept_task = tokio::spawn(async move {
        loop {
            let (mut inbound, _peer) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break, // listener closed → tunnel torn down
            };
            let conn_one = conn_accept.clone();
            let rhost_one = rhost.clone();
            let task = tokio::spawn(async move {
                let channel = match conn_one
                    .channel_open_direct_tcpip(
                        rhost_one,
                        remote_port as u32,
                        "127.0.0.1".to_string(),
                        actual_port as u32,
                    )
                    .await
                {
                    Ok(ch) => ch,
                    Err(_) => return, // server refused (service down?) — drop conn
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut stream).await;
            });
            // Track the live connection so Stop can abort it (not just block new
            // ones); prune finished tasks so the list doesn't grow unbounded.
            if let Ok(mut tasks) = conn_tasks_accept.lock() {
                tasks.retain(|j| !j.is_finished());
                tasks.push(task);
            }
        }
    });

    let id = Uuid::new_v4().to_string();
    let info = TunnelInfo {
        id: id.clone(),
        local_port: actual_port,
        remote_host,
        remote_port,
        label,
    };
    state.sessions.lock().await.insert(
        id,
        TunnelHandle {
            info: info.clone(),
            accept_task,
            conn_tasks,
            _conn: conn,
            _transport: transport_hold,
        },
    );
    Ok(info)
}

#[tauri::command]
pub async fn ssh_tunnel_close(
    state: State<'_, Arc<TunnelManager>>,
    id: String,
) -> Result<(), TunnelError> {
    if let Some(h) = state.sessions.lock().await.remove(&id) {
        h.accept_task.abort(); // stop accepting + free the local port
        // Abort in-flight forwarded connections too — otherwise an already-open
        // browser keep-alive socket keeps working after Stop. Aborting each task
        // drops its TCP socket + SSH channel, so live sessions die immediately.
        if let Ok(mut tasks) = h.conn_tasks.lock() {
            for j in tasks.drain(..) {
                j.abort();
            }
        }
        // dropping h._conn / h._xray then tears down the SSH transport + xray
    } else {
        return Err(TunnelError::NotFound(id));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_tunnel_list(
    state: State<'_, Arc<TunnelManager>>,
) -> Result<Vec<TunnelInfo>, TunnelError> {
    Ok(state
        .sessions
        .lock()
        .await
        .values()
        .map(|h| h.info.clone())
        .collect())
}
