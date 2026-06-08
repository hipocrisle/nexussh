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
use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use russh::{cipher, kex, mac, ChannelMsg, Disconnect, Preferred};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
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
    /// Opt-in to weak legacy algorithms (3DES/CBC/SHA-1 KEX+MAC, ssh-rsa) for
    /// reaching old gear (Cisco IOS / ESXi). OFF by default so a MITM can't
    /// downgrade a modern host — the legacy set is offered only for hosts the
    /// user explicitly flagged.
    #[serde(default)]
    pub allow_legacy: bool,
    /// When true (host-list encryption is on), store/verify the host-key pin in
    /// the encrypted vault rather than plaintext known_hosts.json.
    #[serde(default)]
    pub encrypt_known_hosts: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectResult {
    pub session_id: String,
}

/// Per-session output gate. Frontend's `listen('ssh-data', ...)` is async
/// — if the server sends a banner before the JS listener finishes
/// attaching, those bytes are lost (terminal stays blank even though the
/// connection succeeded). Backend therefore buffers `ssh-data` payloads
/// until the frontend calls `ssh_ready`, then flushes and switches to
/// direct emit.
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

/// Trust-on-first-use host-key handler.
///
/// On first connect to a given `host:port` the SHA-256 fingerprint is recorded
/// in `known_hosts.json` under the app data dir. Subsequent connects accept the
/// key only if it still matches; a mismatch returns `false` so russh aborts the
/// handshake (the user sees a connection error rather than transparently
/// talking to a possibly-MITM'd peer).
/// Reserved vault key holding the known_hosts pin map (JSON) when host-list
/// encryption is on, so connected-host addresses don't sit in plaintext on disk.
pub(crate) const KNOWN_HOSTS_VAULT_KEY: &str = "__known_hosts__";

pub(crate) struct TofuHandler {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) store_path: std::path::PathBuf,
    /// When set, pins live in the encrypted vault (key `__known_hosts__`)
    /// instead of the plaintext file — used when host-list encryption is on.
    pub(crate) app: AppHandle,
    pub(crate) use_vault: bool,
}

fn fingerprint_sha256(key: &PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

/// Serializes the read-modify-write of known_hosts.json so two concurrent
/// first-connects can't clobber each other's pin (lost-update race).
static KNOWN_HOSTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Read the pin store. Distinguishes "file absent" (legitimate empty → Ok)
/// from "file present but unparseable" (corruption → Err, so we refuse to
/// silently drop every pin and accept any key).
fn read_known_hosts(path: &std::path::Path) -> std::io::Result<HashMap<String, String>> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<HashMap<String, String>>(&s).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("known_hosts corrupt: {e}"))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(e),
    }
}

fn write_known_hosts(path: &std::path::Path, map: &HashMap<String, String>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".into());
    // Atomic replace so a crash mid-write can't truncate the pin store.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

/// TOFU verification shared by the shell (`ssh.rs`) and SFTP (`sftp.rs`) so a
/// key trusted on one transport is enforced on the other. Returns Ok(true) to
/// accept, Ok(false) to refuse (changed key), Err on store I/O/corruption — and
/// a first-use pin that can't be persisted is treated as an error (fail closed)
/// rather than silently accepting every future key.
pub(crate) fn verify_known_host(
    store_path: &std::path::Path,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> std::io::Result<bool> {
    let id = format!("{host}:{port}");
    let fp = fingerprint_sha256(key);
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_known_hosts(store_path)?;
    match map.get(&id) {
        Some(known) if known == &fp => Ok(true),
        Some(_) => Ok(false), // key changed — refuse (possible MITM)
        None => {
            map.insert(id, fp);
            write_known_hosts(store_path, &map)?; // fail closed if not persisted
            Ok(true)
        }
    }
}

/// TOFU verification against the encrypted vault (`__known_hosts__` JSON map)
/// instead of the plaintext file. Used when host-list encryption is on, so the
/// addresses of hosts you've connected to aren't left readable on disk.
pub(crate) fn verify_known_host_vault(
    app: &AppHandle,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> std::io::Result<bool> {
    use tauri::Manager;
    let vault = app.state::<crate::vault::VaultState>();
    let id = format!("{host}:{port}");
    let fp = fingerprint_sha256(key);
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map: HashMap<String, String> = crate::vault::get_opt(&vault, KNOWN_HOSTS_VAULT_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    match map.get(&id) {
        Some(known) if known == &fp => Ok(true),
        Some(_) => Ok(false),
        None => {
            map.insert(id, fp);
            let json = serde_json::to_string(&map).unwrap_or_else(|_| "{}".into());
            crate::vault::put(&vault, KNOWN_HOSTS_VAULT_KEY, json)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            Ok(true)
        }
    }
}

impl Handler for TofuHandler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let r = if self.use_vault {
            verify_known_host_vault(&self.app, &self.host, self.port, key)
        } else {
            verify_known_host(&self.store_path, &self.host, self.port, key)
        };
        r.map_err(russh::Error::from)
    }
}

/// Move the plaintext known_hosts.json into the encrypted vault (called when
/// host-list encryption is turned on), then delete the file. Idempotent.
#[tauri::command]
pub async fn known_hosts_to_vault(
    app: AppHandle,
    vault: State<'_, crate::vault::VaultState>,
) -> Result<(), SshError> {
    let path = known_hosts_path(&app);
    let contents = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(SshError::Io(e)),
    };
    crate::vault::put(&vault, KNOWN_HOSTS_VAULT_KEY, contents)
        .map_err(|e| SshError::Other(e.to_string()))?;
    let _ = std::fs::remove_file(&path);
    Ok(())
}

/// Move known_hosts back from the vault to the plaintext file (called when
/// host-list encryption is turned off). Idempotent.
#[tauri::command]
pub async fn known_hosts_from_vault(
    app: AppHandle,
    vault: State<'_, crate::vault::VaultState>,
) -> Result<(), SshError> {
    if let Some(s) = crate::vault::get_opt(&vault, KNOWN_HOSTS_VAULT_KEY) {
        let path = known_hosts_path(&app);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, s)?;
        let _ = crate::vault::put(&vault, KNOWN_HOSTS_VAULT_KEY, String::new());
    }
    Ok(())
}

pub(crate) fn known_hosts_path(app: &AppHandle) -> std::path::PathBuf {
    let mut p = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    p.push("known_hosts.json");
    p
}

/// Grab an ephemeral free localhost port for the xray SOCKS inbound.
pub(crate) fn free_local_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Poll the local SOCKS port until xray accepts connections (or time out).
pub(crate) async fn wait_socks_ready(port: u16) -> Result<(), SshError> {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(SshError::Other("xray SOCKS proxy did not come up in time".into()))
}

/// SOCKS connect via xray with one retry. On a cold start xray accepts the
/// SOCKS port well before the upstream cascade has finished negotiating, so the
/// first `Socks5Stream::connect` to a brand-new VPN can fail before xray has a
/// route. Wait 1.2s and try again — solves the cold-SFTP-via-VPN case the user
/// hit (SSH worked because they sat on the "connecting…" screen long enough to
/// retry implicitly; SFTPPanel did one attempt and gave up).
pub(crate) async fn socks_connect_with_retry(
    proxy: &str,
    host: &str,
    port: u16,
) -> Result<tokio_socks::tcp::Socks5Stream<tokio::net::TcpStream>, tokio_socks::Error>
{
    use tokio_socks::tcp::Socks5Stream;
    match Socks5Stream::connect(proxy, (host, port)).await {
        Ok(s) => Ok(s),
        Err(_) => {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            Socks5Stream::connect(proxy, (host, port)).await
        }
    }
}

/// Permissive algorithm set: modern algorithms first (negotiated whenever the
/// peer supports them), with legacy SHA-1 KEX/MAC and CBC/3DES cipher fallbacks
/// appended so we can still reach old network gear — Cisco IOS, older ESXi,
/// switches/routers — the way PuTTY does. russh's defaults omit the legacy
/// algorithms for security, which leaves that hardware unreachable (KEX/MAC "no
/// match" → connection drops at handshake). Host-key `ssh-rsa` (SHA-1) is the
/// `Rsa { hash: None }` entry. We never *prefer* the weak ones — they only get
/// picked when the device offers nothing stronger.
pub(crate) fn permissive_preferred() -> Preferred {
    Preferred {
        kex: Cow::Owned(vec![
            kex::CURVE25519,
            kex::CURVE25519_PRE_RFC_8731,
            kex::DH_GEX_SHA256,
            kex::DH_G18_SHA512,
            kex::DH_G16_SHA512,
            kex::DH_G14_SHA256,
            // legacy fallback for old gear
            kex::DH_G14_SHA1,
            kex::DH_GEX_SHA1,
            kex::DH_G1_SHA1,
            // capability markers (mirror russh defaults)
            kex::EXTENSION_SUPPORT_AS_CLIENT,
            kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
        ]),
        key: Cow::Owned(vec![
            Algorithm::Ed25519,
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
            Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
            Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
            Algorithm::Rsa { hash: None }, // ssh-rsa (SHA-1) — old gear
        ]),
        cipher: Cow::Owned(vec![
            cipher::CHACHA20_POLY1305,
            cipher::AES_256_GCM,
            cipher::AES_128_GCM,
            cipher::AES_256_CTR,
            cipher::AES_192_CTR,
            cipher::AES_128_CTR,
            // legacy fallback
            cipher::AES_256_CBC,
            cipher::AES_192_CBC,
            cipher::AES_128_CBC,
            cipher::TRIPLE_DES_CBC,
        ]),
        mac: Cow::Owned(vec![
            mac::HMAC_SHA512_ETM,
            mac::HMAC_SHA256_ETM,
            mac::HMAC_SHA512,
            mac::HMAC_SHA256,
            // legacy fallback
            mac::HMAC_SHA1_ETM,
            mac::HMAC_SHA1,
        ]),
        compression: Preferred::DEFAULT.compression.clone(),
    }
}

/// Algorithm set for every connection. We ALWAYS offer the permissive set —
/// modern algorithms first, legacy (SHA-1 KEX/MAC, CBC/3DES, ssh-rsa) only as a
/// fallback. SSH negotiates the STRONGEST mutually-supported algorithm and the
/// negotiation is covered by the signed exchange hash, so a modern host is never
/// downgraded; old gear (Cisco IOS/SX, ESXi) just connects. This replaces the
/// per-host "legacy algorithms" toggle — the client figures it out itself.
pub(crate) fn preferred_for(_allow_legacy: bool) -> Preferred {
    permissive_preferred()
}

/// Keyboard-interactive auth, answering username-ish prompts with the user and
/// every other prompt with the password (covers the typical single "Password:").
async fn try_keyboard_interactive<H: russh::client::Handler>(
    session: &mut russh::client::Handle<H>,
    user: &str,
    password: &str,
) -> Result<bool, russh::Error> {
    use russh::client::KeyboardInteractiveAuthResponse as Ki;
    let mut resp = session
        .authenticate_keyboard_interactive_start(user, None)
        .await?;
    for _ in 0..16 {
        match resp {
            Ki::Success => return Ok(true),
            Ki::Failure { .. } => return Ok(false),
            Ki::InfoRequest { prompts, .. } => {
                let answers = prompts
                    .iter()
                    .map(|p| {
                        let l = p.prompt.to_lowercase();
                        if l.contains("user") || l.contains("login") || l.contains("name") {
                            user.to_string()
                        } else {
                            password.to_string()
                        }
                    })
                    .collect();
                resp = session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
    Ok(false)
}

/// Password / keyboard-interactive auth, the RFC 4252 way: probe with "none"
/// first to learn the methods the server actually accepts, then use them.
///
/// This is what fixed old Cisco (SX550): sending a method UNSOLICITED (no "none"
/// probe) made the switch reply with an empty method set and drop the session
/// ("Channel send error" — confirmed via the protocol log). With the "none"
/// probe it advertises its real methods and we pick the right one.
async fn authenticate<H: russh::client::Handler>(
    session: &mut russh::client::Handle<H>,
    user: &str,
    password: &str,
) -> Result<bool, russh::Error> {
    use russh::client::AuthResult;
    let methods = match session.authenticate_none(user).await? {
        AuthResult::Success => return Ok(true), // server allows no-auth
        AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };
    // MethodKind isn't nameable (private module), so match by its wire name.
    // Empty set → server didn't list anything useful; try both as a last resort.
    let offers = |name: &str| {
        methods.is_empty()
            || methods.iter().any(|m| {
                let s: &str = m.into();
                s == name
            })
    };
    if offers("password")
        && session.authenticate_password(user, password).await?.success()
    {
        return Ok(true);
    }
    if offers("keyboard-interactive") {
        return try_keyboard_interactive(session, user, password).await;
    }
    Ok(false)
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, Arc<SessionManager>>,
    vault: State<'_, crate::vault::VaultState>,
    args: ConnectArgs,
) -> Result<ConnectResult, SshError> {
    // Fresh protocol trace for this attempt so a failure shows just its lines.
    crate::sshlog::clear();
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
    // Offer legacy algorithms only when the host opted in (old gear Cisco/ESXi).
    cfg.preferred = preferred_for(args.allow_legacy);
    let config = Arc::new(cfg);

    // Establish the transport stream: either a direct TCP connect, or — when
    // the host is flagged "via built-in VPN" — through a local xray SOCKS5
    // proxy that egresses via the chosen node (userspace, no TUN/admin).
    let handler = TofuHandler {
        host: args.host.clone(),
        port: args.port,
        store_path: known_hosts_path(&app),
        app: app.clone(),
        use_vault: args.encrypt_known_hosts,
    };
    let (mut session, xray_child) = if let Some(node) = &args.vpn {
        let socks_port = free_local_port()?;
        let child = crate::vpn::spawn_xray(node, socks_port)
            .map_err(|e| SshError::Other(format!("xray spawn: {e}")))?;
        wait_socks_ready(socks_port).await?;
        let proxy = format!("127.0.0.1:{socks_port}");
        let stream = socks_connect_with_retry(proxy.as_str(), &args.host, args.port)
            .await
            .map_err(|e| SshError::Other(format!("socks connect: {e}")))?;
        let session =
            client::connect_stream(config, stream.into_inner(), handler).await?;
        (session, Some(child))
    } else {
        let addr = format!("{}:{}", args.host, args.port);
        let session = client::connect(config, addr.as_str(), handler).await?;
        (session, None)
    };

    let auth_ok = match &args.auth {
        AuthMethod::Password { password } => {
            authenticate(&mut session, &args.user, password).await?
        }
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
            authenticate(&mut session, &args.user, &secret).await?
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
            gate,
        )
        .await;
        manager.sessions.lock().await.remove(&sid);
        // Flush + seal the recording for this session (no-op if not recording).
        crate::history::finalize_session(&app_handle, &sid);
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
    session: client::Handle<TofuHandler>,
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
        // Feed the (optional) history recorder before we hand the bytes off to
        // the frontend — a no-op unless this session is being recorded. Does NOT
        // delay display: the emit/buffer happens right after.
        crate::history::record_output(app, sid, &bytes);
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
                        ship(app, sid, &gate, data.to_vec()).await;
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        // stderr arrives here in some shells; merge into the same stream
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
