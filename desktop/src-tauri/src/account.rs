//! NexuSSH account-based sync — Phase-1 CLIENT side.
//!
//! Design: `/matrix/docs/nexussh-account-sync-design.md`. This module provides
//! (a) account auth (register / login / logout / TOTP) and (b) a per-item sync
//! engine that bridges the **local vault KV store** (`vault.rs`) to the server's
//! per-item encrypted store.
//!
//! # One master password
//! ONE master password serves BOTH the local vault (age-scrypt → DEK, unchanged)
//! AND the account sync. The account path uses the split-KDF in
//! [`crate::account_crypto`]: `auth_hash` is the server login verifier and a
//! random `user_key` (wrapped under the password and a recovery key) encrypts
//! every item. The unwrapped `user_key` lives in memory only — like the vault
//! DEK — and is cleared on logout. Registration REQUIRES the vault to be set up
//! with the same password (we don't store the password, so we can't verify
//! equality directly; we document the coupling and require the caller to pass the
//! same password used for the vault).
//!
//! # Item ⇄ vault mapping
//! Each vault KV entry becomes exactly ONE server item:
//!   * `item_id` = the vault key verbatim (e.g. `__hostlist__`,
//!     `host.<id>.password`, `nexussh.known_hosts.<id>`).
//!   * `type`    = derived from the key prefix ([`item_type_for_key`]).
//!   * `ciphertext` = `account_crypto::encrypt_item(value_bytes, user_key)`.
//! On pull we decrypt with `user_key` and write the value back into the vault.
//!
//! # ALL crypto goes through [`crate::account_crypto`]
//! This module never derives keys or seals/opens AEAD itself; it only calls the
//! Phase-0 primitives. The server never receives plaintext, the password, or any
//! key — only base64 ciphertext + metadata.

use crate::account_crypto as ac;
use crate::vault::{self, VaultState};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

/// Default sync server (future deploy). Overridable via [`account_set_server`].
const DEFAULT_SERVER_URL: &str = "https://sync.hipogas.org";
/// Filename of the local (non-secret) account config under the app config dir.
const CONFIG_FILE: &str = "account-config.json";

// ===========================================================================
// Errors
// ===========================================================================

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error("account crypto: {0}")]
    Crypto(#[from] ac::CryptoError),
    #[error("vault: {0}")]
    Vault(#[from] vault::VaultError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("base64: {0}")]
    B64(#[from] base64::DecodeError),
    #[error("not logged in — call account_login")]
    NotLoggedIn,
    /// Login needs a TOTP code the caller hasn't supplied yet. The UI catches
    /// this to prompt for the code.
    #[error("totp required")]
    TotpRequired,
    #[error("server returned {status}: {body}")]
    Server { status: u16, body: String },
    #[error("http: {0}")]
    Http(String),
    #[error("not configured — register or login first")]
    NotConfigured,
    #[error("{0}")]
    Other(String),
}

impl Serialize for AccountError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type Result<T> = std::result::Result<T, AccountError>;

// ===========================================================================
// In-memory session (cleared on logout) — mirrors how the vault holds its DEK.
// ===========================================================================

/// Live session: the bearer token + the unwrapped user key. Present only while
/// logged in; `account_logout` drops it (zeroizing the key).
struct Session {
    token: String,
    user_key: Zeroizing<[u8; 32]>,
}

#[derive(Default)]
pub struct AccountState {
    inner: Mutex<Option<Session>>,
}

// ===========================================================================
// Local config file (NOT in the vault — the token is not a long-term secret).
// ===========================================================================

/// Persisted, non-secret account config + sync bookkeeping. Lives at
/// `<app_config_dir>/account-config.json`. The user key and password are NEVER
/// written here; only the (short-lived) session token, identifiers, and the
/// sync rev/updated_at maps needed for delta + last-writer-wins.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccountConfig {
    server_url: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
    /// Session bearer token. Re-fetched on every login; persisted so a restart
    /// can resume without re-login until it expires (server-enforced).
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    totp_enabled: bool,
    /// Highest server rev we've fully pulled (the `since` cursor).
    #[serde(default)]
    last_sync_rev: u64,
    /// Wall-clock ms of the last successful sync (for status display).
    #[serde(default)]
    last_sync_at: Option<u64>,
    /// Per-item last-seen server rev — the `base_rev` we push with (CAS).
    #[serde(default)]
    item_revs: HashMap<String, u64>,
    /// Per-key local updated_at (ms) — the LWW timestamp. Updated whenever we
    /// write a key locally (or accept a remote one). Drives "what changed since
    /// last sync" for push and conflict resolution.
    #[serde(default)]
    updated_at: HashMap<String, u64>,
    /// Keys we know to have been deleted locally (tombstones to push). Maps the
    /// key to the deletion timestamp (ms). Cleared once the server acks them.
    #[serde(default)]
    tombstones: HashMap<String, u64>,
    /// True once the first full push has happened. Before it, push uploads
    /// EVERYTHING (we can't know what "changed" on a brand-new device).
    #[serde(default)]
    did_initial_push: bool,
}

impl Default for AccountConfig {
    fn default() -> Self {
        AccountConfig {
            server_url: DEFAULT_SERVER_URL.to_string(),
            username: None,
            device_id: None,
            token: None,
            totp_enabled: false,
            last_sync_rev: 0,
            last_sync_at: None,
            item_revs: HashMap::new(),
            updated_at: HashMap::new(),
            tombstones: HashMap::new(),
            did_initial_push: false,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AccountError::Other(e.to_string()))?;
    Ok(dir.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> Result<AccountConfig> {
    let path = config_path(app)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        // Missing file → fresh default config (server URL = default).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AccountConfig::default()),
        Err(e) => Err(e.into()),
    }
}

/// Persist the config atomically (write tmp + rename) so a crash mid-write never
/// leaves a truncated, unparseable config that would wedge sync.
fn save_config(app: &AppHandle, cfg: &AccountConfig) -> Result<()> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(cfg)?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===========================================================================
// Item ⇄ vault key mapping
// ===========================================================================

/// Derive the server item `type` from a vault key. Purely a hint for the server
/// (and future UI); the `item_id` is always the full key, so types never collide.
pub fn item_type_for_key(key: &str) -> &'static str {
    if key == "__hostlist__" {
        "hostlist"
    } else if key.starts_with("host.") && key.ends_with(".password") {
        "password"
    } else if key.starts_with("nexussh.known_hosts.") {
        "known_host"
    } else {
        "other"
    }
}

// ===========================================================================
// HTTP client (ureq, blocking — run on a worker thread by the async commands).
// ===========================================================================

/// JSON POST helper. Adds `Authorization: Bearer` when `token` is Some. Maps
/// non-2xx into [`AccountError::Server`] with the body, and 401-with-totp into
/// [`AccountError::TotpRequired`] for the login path.
fn http_post_json(
    base_url: &str,
    path: &str,
    token: Option<&str>,
    body: &serde_json::Value,
) -> Result<serde_json::Value> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut req = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .set("Content-Type", "application/json")
        .set("User-Agent", "NexuSSH");
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    match req.send_json(body.clone()) {
        Ok(resp) => {
            let txt = resp.into_string().map_err(|e| AccountError::Http(e.to_string()))?;
            if txt.is_empty() {
                return Ok(serde_json::Value::Null);
            }
            Ok(serde_json::from_str(&txt)?)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            // login returns 401 {totp_required:true} when a code is needed.
            if code == 401 {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    if v.get("totp_required").and_then(|b| b.as_bool()) == Some(true) {
                        return Err(AccountError::TotpRequired);
                    }
                }
            }
            Err(AccountError::Server { status: code, body })
        }
        Err(e) => Err(AccountError::Http(e.to_string())),
    }
}

/// JSON GET helper (used for `/v1/items?since=`).
fn http_get_json(base_url: &str, path: &str, token: &str) -> Result<serde_json::Value> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    match ureq::get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .set("User-Agent", "NexuSSH")
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(resp) => {
            let txt = resp.into_string().map_err(|e| AccountError::Http(e.to_string()))?;
            Ok(serde_json::from_str(&txt)?)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Err(AccountError::Server { status: code, body })
        }
        Err(e) => Err(AccountError::Http(e.to_string())),
    }
}

// ===========================================================================
// Status
// ===========================================================================

#[derive(Debug, Clone, Serialize)]
pub struct AccountStatus {
    /// True when a user key is held in memory (logged in this session).
    pub logged_in: bool,
    pub username: Option<String>,
    pub totp_enabled: bool,
    pub last_sync_at: Option<u64>,
    pub server_url: String,
    /// True once a username has been registered/logged-in on this device.
    pub configured: bool,
}

#[tauri::command]
pub async fn account_status(
    app: AppHandle,
    state: State<'_, AccountState>,
) -> Result<AccountStatus> {
    let cfg = load_config(&app)?;
    let logged_in = state.inner.lock().unwrap().is_some();
    Ok(AccountStatus {
        logged_in,
        username: cfg.username.clone(),
        totp_enabled: cfg.totp_enabled,
        last_sync_at: cfg.last_sync_at,
        server_url: cfg.server_url,
        configured: cfg.username.is_some(),
    })
}

#[tauri::command]
pub async fn account_set_server(app: AppHandle, url: String) -> Result<()> {
    let url = url.trim().to_string();
    if !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") {
        return Err(AccountError::Other(
            "server URL must be https:// (or http://127.0.0.1 for local dev)".into(),
        ));
    }
    let mut cfg = load_config(&app)?;
    cfg.server_url = url;
    save_config(&app, &cfg)?;
    Ok(())
}

// ===========================================================================
// Register
// ===========================================================================

/// Returned once from `account_register` — the emergency-kit recovery key the
/// user must save. Never persisted; shown a single time.
#[derive(Debug, Clone, Serialize)]
pub struct RegisterResult {
    pub user_id: String,
    /// Human-readable recovery key ("emergency kit"). SHOW ONCE.
    pub recovery_key: String,
}

/// Register a new account. The password MUST equal the vault master password
/// (the unified-password design). We require the vault to be unlocked so we fail
/// loudly if there is no vault yet — otherwise the user could create an account
/// whose password diverges from a later-created vault. We do NOT (cannot) verify
/// the two passwords are byte-equal here; that coupling is enforced by the UI
/// passing the same password it used for the vault.
#[tauri::command]
pub async fn account_register(
    app: AppHandle,
    vault_state: State<'_, VaultState>,
    password: String,
    username: String,
) -> Result<RegisterResult> {
    // Coupling guard: the account password is the vault master password, so the
    // vault must exist & be unlocked. (See module docs / report for the caveat
    // that byte-equality can't be checked here.)
    if !vault::is_unlocked(&vault_state) {
        return Err(AccountError::Other(
            "unlock (or create) the vault first — the account uses the same master password".into(),
        ));
    }
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(AccountError::Other("username is empty".into()));
    }
    let cfg = load_config(&app)?;
    let server_url = cfg.server_url.clone();

    // Phase-0 crypto: derive split-KDF material, mint+wrap the user key. The
    // user key is uploaded (wrapped) inside the payload; the caller logs in
    // afterwards to obtain a token and hold the live user key in memory.
    let reg = ac::prepare_registration(&password)?;
    let recovery_kit = ac::format_recovery_key(&reg.recovery_key);

    let payload = reg.payload;
    let body = serde_json::json!({
        "username": username.clone(),
        "auth_hash": payload.auth_hash,
        "account_salt": payload.account_salt,
        "kdf_params": payload.kdf_params,
        "wrapped_user_key": payload.wrapped_user_key,
        "recovery_wrapped_user_key": payload.recovery_wrapped_user_key,
    });

    let url = server_url.clone();
    let resp = tokio::task::spawn_blocking(move || {
        http_post_json(&url, "/v1/register", None, &body)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;

    let user_id = resp
        .get("user_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // Persist the username so the device is "configured"; the user still logs in
    // to obtain a token + hold the user key. (Server may also return a token on
    // register; we keep it simple and require an explicit login.)
    let mut cfg = load_config(&app)?;
    cfg.username = Some(username);
    save_config(&app, &cfg)?;

    Ok(RegisterResult {
        user_id,
        recovery_key: recovery_kit,
    })
}

// ===========================================================================
// Login
// ===========================================================================

#[derive(Debug, Clone, Serialize)]
pub struct LoginResult {
    pub user_id: String,
    pub totp_enabled: bool,
}

/// Log in: prelogin (fetch salt/params) → derive master/auth_hash + unwrap the
/// user key with the password → POST /login with auth_hash (+ optional totp) →
/// store token + hold user key in memory.
#[tauri::command]
pub async fn account_login(
    app: AppHandle,
    state: State<'_, AccountState>,
    password: String,
    username: String,
    totp: Option<String>,
) -> Result<LoginResult> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(AccountError::Other("username is empty".into()));
    }
    let cfg = load_config(&app)?;
    let server_url = cfg.server_url.clone();

    // 1. prelogin → account_salt + kdf_params (so we derive identically).
    let pre_body = serde_json::json!({ "username": username.clone() });
    let url = server_url.clone();
    let pre = tokio::task::spawn_blocking(move || {
        http_post_json(&url, "/v1/prelogin", None, &pre_body)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;

    let account_salt = pre
        .get("account_salt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("prelogin missing account_salt".into()))?
        .to_string();
    let kdf_params = match pre.get("kdf_params") {
        // server may send the params as a json string or an object; normalize to
        // the canonical string account_crypto::login expects.
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => return Err(AccountError::Other("prelogin missing kdf_params".into())),
    };

    // 2. Derive the auth_hash from the password (the wrapped_user_key comes back
    //    from /login, so we compute auth_hash separately first).
    let salt_bytes = B64.decode(&account_salt)?;
    let params = ac::KdfParams::from_str(&kdf_params)?;
    let master_key = ac::derive_master_key(&password, &salt_bytes, &params)?;
    let auth_hash_b64 = B64.encode(ac::auth_hash(&master_key, &salt_bytes)?);

    // 3. /login with auth_hash (+ totp if provided).
    let mut login_body = serde_json::json!({
        "username": username.clone(),
        "auth_hash": auth_hash_b64,
        "device_name": device_name(),
    });
    if let Some(code) = totp.as_ref().filter(|c| !c.trim().is_empty()) {
        login_body["totp"] = serde_json::json!(code.trim());
    }
    let url = server_url.clone();
    let login = tokio::task::spawn_blocking(move || {
        http_post_json(&url, "/v1/login", None, &login_body)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;
    // (TotpRequired propagates out of http_post_json as its own error variant.)

    let token = login
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("login response missing token".into()))?
        .to_string();
    let user_id = login
        .get("user_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let device_id = login
        .get("device_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let totp_enabled = login
        .get("totp_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let wrapped_user_key = login
        .get("wrapped_user_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("login response missing wrapped_user_key".into()))?;

    // 4. Unwrap the user key with the password (re-uses account_crypto::login,
    //    which recomputes master/wrap key and AEAD-opens the wrapped key). A
    //    wrong password surfaces as CryptoError::Decrypt.
    let lr = ac::login(&password, &account_salt, &kdf_params, wrapped_user_key)?;
    let user_key = lr.user_key;

    // 5. Persist config + hold the session in memory.
    let mut cfg = load_config(&app)?;
    cfg.username = Some(username);
    cfg.token = Some(token.clone());
    if device_id.is_some() {
        cfg.device_id = device_id;
    }
    cfg.totp_enabled = totp_enabled;
    save_config(&app, &cfg)?;

    *state.inner.lock().unwrap() = Some(Session { token, user_key });

    Ok(LoginResult {
        user_id,
        totp_enabled,
    })
}

fn device_name() -> String {
    format!("NexuSSH {}", std::env::consts::OS)
}

// ===========================================================================
// Logout
// ===========================================================================

/// Clear the token + user key from memory and from the persisted config. Keeps
/// username/server so the next login is pre-filled.
#[tauri::command]
pub async fn account_logout(
    app: AppHandle,
    state: State<'_, AccountState>,
) -> Result<()> {
    *state.inner.lock().unwrap() = None; // drops Session → zeroizes user_key
    let mut cfg = load_config(&app)?;
    cfg.token = None;
    save_config(&app, &cfg)?;
    Ok(())
}

// ===========================================================================
// TOTP enroll / verify
// ===========================================================================

#[derive(Debug, Clone, Serialize)]
pub struct TotpEnroll {
    pub secret: String,
    pub otpauth_url: String,
}

#[tauri::command]
pub async fn account_totp_enroll(
    app: AppHandle,
    state: State<'_, AccountState>,
) -> Result<TotpEnroll> {
    let (token, server_url) = session_token(&app, &state)?;
    let resp = tokio::task::spawn_blocking(move || {
        http_post_json(&server_url, "/v1/totp/enroll", Some(&token), &serde_json::json!({}))
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;
    Ok(TotpEnroll {
        secret: resp
            .get("secret")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        otpauth_url: resp
            .get("otpauth_url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[tauri::command]
pub async fn account_totp_verify(
    app: AppHandle,
    state: State<'_, AccountState>,
    code: String,
) -> Result<Vec<String>> {
    let (token, server_url) = session_token(&app, &state)?;
    let body = serde_json::json!({ "code": code.trim() });
    let resp = tokio::task::spawn_blocking(move || {
        http_post_json(&server_url, "/v1/totp/verify", Some(&token), &body)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;
    let codes: Vec<String> = resp
        .get("recovery_codes")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    // Mark TOTP enabled in local config now that verification succeeded.
    let mut cfg = load_config(&app)?;
    cfg.totp_enabled = true;
    save_config(&app, &cfg)?;
    Ok(codes)
}

/// Fetch the live bearer token + server URL, or error if not logged in.
fn session_token(app: &AppHandle, state: &State<'_, AccountState>) -> Result<(String, String)> {
    let token = {
        let guard = state.inner.lock().unwrap();
        guard.as_ref().ok_or(AccountError::NotLoggedIn)?.token.clone()
    };
    let cfg = load_config(app)?;
    Ok((token, cfg.server_url))
}

// ===========================================================================
// Sync engine
// ===========================================================================

/// Server item as returned by `GET /v1/items`.
#[derive(Debug, Clone, Deserialize)]
struct RemoteItem {
    item_id: String,
    #[allow(dead_code)]
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    ciphertext: String,
    rev: u64,
    #[serde(default)]
    #[allow(dead_code)]
    updated_at: Option<u64>,
    #[serde(default)]
    deleted: bool,
}

#[derive(Debug, Deserialize)]
struct PullResponse {
    #[serde(default)]
    items: Vec<RemoteItem>,
    #[serde(default)]
    latest_rev: u64,
}

/// One change we push.
#[derive(Debug, Clone, Serialize)]
struct PushChange {
    item_id: String,
    r#type: String,
    ciphertext: String,
    updated_at: u64,
    deleted: bool,
    base_rev: u64,
}

#[derive(Debug, Deserialize)]
struct PushResult {
    item_id: String,
    #[serde(default)]
    rev: u64,
    status: String,
    #[serde(default)]
    server: Option<RemoteItem>,
}

#[derive(Debug, Deserialize)]
struct PushResponse {
    #[serde(default)]
    results: Vec<PushResult>,
    #[serde(default)]
    latest_rev: u64,
}

/// Outcome summary returned to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct SyncReport {
    pub pulled: usize,
    pub pushed: usize,
    pub deleted_locally: usize,
    pub conflicts: usize,
    pub latest_rev: u64,
}

/// THE sync engine. Requires: logged in (token + user_key in memory) AND vault
/// unlocked (DEK available). Pull-then-push with last-writer-wins + tombstones.
///
/// Correctness over cleverness: we write into the vault per-key (never wholesale)
/// so a partial failure can't corrupt it, and we persist the rev/updated_at maps
/// at the end.
#[tauri::command]
pub async fn account_sync_now(
    app: AppHandle,
    state: State<'_, AccountState>,
    vault_state: State<'_, VaultState>,
) -> Result<SyncReport> {
    // Preconditions: session (token + user_key) and an unlocked vault.
    let (token, user_key) = {
        let guard = state.inner.lock().unwrap();
        let s = guard.as_ref().ok_or(AccountError::NotLoggedIn)?;
        (s.token.clone(), s.user_key.clone())
    };
    if !vault::is_unlocked(&vault_state) {
        return Err(AccountError::Vault(vault::VaultError::Locked));
    }
    let mut cfg = load_config(&app)?;
    let server_url = cfg.server_url.clone();

    let mut report = SyncReport {
        pulled: 0,
        pushed: 0,
        deleted_locally: 0,
        conflicts: 0,
        latest_rev: cfg.last_sync_rev,
    };

    // -------------------------------------------------------------------
    // 1. PULL: GET /v1/items?since=last_sync_rev
    // -------------------------------------------------------------------
    let since = cfg.last_sync_rev;
    let url = server_url.clone();
    let tok = token.clone();
    let pull_raw = tokio::task::spawn_blocking(move || {
        http_get_json(&url, &format!("/v1/items?since={since}"), &tok)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;
    let pull: PullResponse = serde_json::from_value(pull_raw)?;

    for item in &pull.items {
        let key = &item.item_id;
        let local_updated = cfg.updated_at.get(key).copied().unwrap_or(0);
        let remote_updated = item.updated_at.unwrap_or(0);

        if item.deleted {
            // Tombstone: remove the local key UNLESS our copy is strictly newer
            // (we then keep ours and will push it back, re-creating the item).
            if local_updated <= remote_updated || remote_updated == 0 {
                if vault::get_opt(&vault_state, key).is_some() {
                    vault::delete_key(&vault_state, key)?;
                    report.deleted_locally += 1;
                }
                cfg.updated_at.remove(key);
                cfg.tombstones.remove(key); // server already has the tombstone
            }
            cfg.item_revs.insert(key.clone(), item.rev);
            report.latest_rev = report.latest_rev.max(item.rev);
            report.pulled += 1;
            continue;
        }

        // Decrypt the remote ciphertext with the user key.
        let ct = B64.decode(&item.ciphertext)?;
        let plaintext = ac::decrypt_item(&ct, &user_key)?;
        let remote_value = String::from_utf8_lossy(&plaintext).into_owned();

        // LWW: apply remote only when it is at least as new as our local copy.
        // Equal timestamps → remote wins (idempotent: same content typically).
        let local_value = vault::get_opt(&vault_state, key);
        let apply_remote = match &local_value {
            None => true, // we don't have it → take remote.
            Some(lv) => {
                if lv == &remote_value {
                    false // identical, nothing to do.
                } else {
                    remote_updated >= local_updated
                }
            }
        };
        if apply_remote {
            vault::put_key(&vault_state, key, remote_value)?; // per-key write
            cfg.updated_at.insert(key.clone(), remote_updated.max(local_updated));
            cfg.tombstones.remove(key);
            report.pulled += 1;
        }
        cfg.item_revs.insert(key.clone(), item.rev);
        report.latest_rev = report.latest_rev.max(item.rev);
    }
    cfg.last_sync_rev = report.latest_rev.max(pull.latest_rev);

    // -------------------------------------------------------------------
    // 2. PUSH: gather locally-changed keys + tombstones.
    // -------------------------------------------------------------------
    let local_keys = vault::list_keys(&vault_state)?;
    let mut changes: Vec<PushChange> = Vec::new();

    for key in &local_keys {
        // Skip non-syncable bookkeeping keys if any are introduced later; for now
        // every vault KV entry is an item.
        let value = match vault::get_opt(&vault_state, key) {
            Some(v) => v,
            None => continue,
        };
        let base_rev = cfg.item_revs.get(key).copied().unwrap_or(0);
        let updated_at = *cfg.updated_at.entry(key.clone()).or_insert_with(now_ms);

        // On the first sync push everything; afterwards push only keys the server
        // hasn't acked at this rev (base_rev 0 = never pushed) OR whose local
        // updated_at is newer than the last sync.
        let changed = !cfg.did_initial_push
            || base_rev == 0
            || updated_at > cfg.last_sync_at.unwrap_or(0);
        if !changed {
            continue;
        }
        let ct = ac::encrypt_item(value.as_bytes(), &user_key)?;
        changes.push(PushChange {
            item_id: key.clone(),
            r#type: item_type_for_key(key).to_string(),
            ciphertext: B64.encode(&ct),
            updated_at,
            deleted: false,
            base_rev,
        });
    }

    // Tombstones for keys deleted locally since last sync.
    for (key, ts) in cfg.tombstones.clone() {
        let base_rev = cfg.item_revs.get(&key).copied().unwrap_or(0);
        changes.push(PushChange {
            item_id: key.clone(),
            r#type: item_type_for_key(&key).to_string(),
            ciphertext: String::new(),
            updated_at: ts,
            deleted: true,
            base_rev,
        });
    }

    if !changes.is_empty() {
        let body = serde_json::json!({ "changes": changes });
        let url = server_url.clone();
        let tok = token.clone();
        let push_raw = tokio::task::spawn_blocking(move || {
            http_post_json(&url, "/v1/items", Some(&tok), &body)
        })
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;
        let push: PushResponse = serde_json::from_value(push_raw)?;

        for res in &push.results {
            match res.status.as_str() {
                "ok" => {
                    cfg.item_revs.insert(res.item_id.clone(), res.rev);
                    // Pushed tombstones are now durable on the server → drop ours.
                    if cfg.tombstones.remove(&res.item_id).is_some() {
                        cfg.updated_at.remove(&res.item_id);
                    }
                    report.pushed += 1;
                    report.latest_rev = report.latest_rev.max(res.rev);
                }
                "conflict" => {
                    report.conflicts += 1;
                    // Server returned its newer version → resolve LWW + retry.
                    if let Some(srv) = &res.server {
                        resolve_conflict(
                            &vault_state,
                            &user_key,
                            &mut cfg,
                            srv,
                            &server_url,
                            &token,
                            &mut report,
                        )
                        .await?;
                    }
                }
                other => {
                    return Err(AccountError::Other(format!(
                        "unexpected push status '{other}' for {}",
                        res.item_id
                    )));
                }
            }
        }
        cfg.last_sync_rev = cfg.last_sync_rev.max(push.latest_rev);
        report.latest_rev = report.latest_rev.max(push.latest_rev);
    }

    cfg.did_initial_push = true;
    cfg.last_sync_at = Some(now_ms());
    cfg.last_sync_rev = cfg.last_sync_rev.max(report.latest_rev);
    save_config(&app, &cfg)?;
    Ok(report)
}

/// Resolve a single per-item conflict: the server gave us its current version.
/// Apply LWW (decrypt server value, compare updated_at), then if WE still win,
/// re-push our value with the server's rev as the new base_rev.
async fn resolve_conflict(
    vault_state: &State<'_, VaultState>,
    user_key: &[u8; 32],
    cfg: &mut AccountConfig,
    srv: &RemoteItem,
    server_url: &str,
    token: &str,
    report: &mut SyncReport,
) -> Result<()> {
    let key = &srv.item_id;
    cfg.item_revs.insert(key.clone(), srv.rev);
    report.latest_rev = report.latest_rev.max(srv.rev);

    let remote_updated = srv.updated_at.unwrap_or(0);
    let local_updated = cfg.updated_at.get(key).copied().unwrap_or(0);

    if srv.deleted {
        // Server deleted it. If our copy is newer we re-create it; else accept.
        if local_updated > remote_updated {
            // We win → push our current value with the server rev as base.
            if let Some(value) = vault::get_opt(vault_state, key) {
                let ct = ac::encrypt_item(value.as_bytes(), user_key)?;
                push_single(cfg, server_url, token, key, item_type_for_key(key), &B64.encode(&ct), local_updated, false, report).await?;
            }
        } else {
            if vault::get_opt(vault_state, key).is_some() {
                vault::delete_key(vault_state, key)?;
                report.deleted_locally += 1;
            }
            cfg.updated_at.remove(key);
        }
        return Ok(());
    }

    // Server has a value. Decrypt + LWW.
    let ct = B64.decode(&srv.ciphertext)?;
    let remote_value = String::from_utf8_lossy(&ac::decrypt_item(&ct, user_key)?).into_owned();
    let local_value = vault::get_opt(vault_state, key);

    match local_value {
        Some(lv) if remote_updated < local_updated && lv != remote_value => {
            // We win → re-push our value with the server rev as the new base.
            let ct = ac::encrypt_item(lv.as_bytes(), user_key)?;
            push_single(cfg, server_url, token, key, &item_type_for_key(key), &B64.encode(&ct), local_updated, false, report).await?;
        }
        _ => {
            // Remote wins (or equal) → take it.
            vault::put_key(vault_state, key, remote_value)?;
            cfg.updated_at.insert(key.clone(), remote_updated.max(local_updated));
            report.pulled += 1;
        }
    }
    Ok(())
}

/// Push a single change (used by conflict retry) with an explicit base_rev taken
/// from the freshly-learned server rev. One retry only — if the server conflicts
/// again we record it and move on (the next manual sync resolves it).
#[allow(clippy::too_many_arguments)]
async fn push_single(
    cfg: &mut AccountConfig,
    server_url: &str,
    token: &str,
    key: &str,
    item_type: &str,
    ciphertext_b64: &str,
    updated_at: u64,
    deleted: bool,
    report: &mut SyncReport,
) -> Result<()> {
    let base_rev = cfg.item_revs.get(key).copied().unwrap_or(0);
    let change = PushChange {
        item_id: key.to_string(),
        r#type: item_type.to_string(),
        ciphertext: ciphertext_b64.to_string(),
        updated_at,
        deleted,
        base_rev,
    };
    let body = serde_json::json!({ "changes": [change] });
    let url = server_url.to_string();
    let tok = token.to_string();
    let raw = tokio::task::spawn_blocking(move || {
        http_post_json(&url, "/v1/items", Some(&tok), &body)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;
    let resp: PushResponse = serde_json::from_value(raw)?;
    for res in &resp.results {
        if res.status == "ok" {
            cfg.item_revs.insert(res.item_id.clone(), res.rev);
            report.pushed += 1;
            report.latest_rev = report.latest_rev.max(res.rev);
        } else {
            // Still conflicting — give up on this retry; next sync handles it.
            report.conflicts += 1;
        }
    }
    Ok(())
}

// ===========================================================================
// Tests — item⇄vault mapping + encrypt/pull/apply round-trip with a fake key.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_user_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    // --- key → type mapping -------------------------------------------------

    #[test]
    fn type_for_hostlist() {
        assert_eq!(item_type_for_key("__hostlist__"), "hostlist");
    }

    #[test]
    fn type_for_password() {
        assert_eq!(item_type_for_key("host.abc123.password"), "password");
    }

    #[test]
    fn type_for_known_host() {
        assert_eq!(
            item_type_for_key("nexussh.known_hosts.host-42"),
            "known_host"
        );
    }

    #[test]
    fn type_for_other() {
        assert_eq!(item_type_for_key("some.random.key"), "other");
        assert_eq!(item_type_for_key("host.abc.username"), "other");
    }

    // --- item encrypt → (simulated server) → decrypt round-trip -------------

    #[test]
    fn item_round_trips_through_b64_ciphertext() {
        let uk = fake_user_key();
        let value = "super-secret-host-password\nwith newline";
        // PUSH side: encrypt + base64 (what we send as `ciphertext`).
        let ct = ac::encrypt_item(value.as_bytes(), &uk).unwrap();
        let ct_b64 = B64.encode(&ct);

        // PULL side: base64-decode + decrypt (what the engine does on pull).
        let ct2 = B64.decode(&ct_b64).unwrap();
        let pt = ac::decrypt_item(&ct2, &uk).unwrap();
        let recovered = String::from_utf8(pt).unwrap();
        assert_eq!(recovered, value);
    }

    #[test]
    fn push_change_serializes_with_snake_and_type() {
        let c = PushChange {
            item_id: "__hostlist__".into(),
            r#type: "hostlist".into(),
            ciphertext: "Zm9v".into(),
            updated_at: 1_700_000_000_000,
            deleted: false,
            base_rev: 7,
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["item_id"], "__hostlist__");
        assert_eq!(v["type"], "hostlist");
        assert_eq!(v["base_rev"], 7);
        assert_eq!(v["deleted"], false);
    }

    #[test]
    fn remote_item_deserializes_from_server_shape() {
        let json = serde_json::json!({
            "item_id": "host.x.password",
            "type": "password",
            "ciphertext": "AAAA",
            "rev": 12,
            "updated_at": 1_700_000_000_000u64,
            "deleted": false
        });
        let item: RemoteItem = serde_json::from_value(json).unwrap();
        assert_eq!(item.item_id, "host.x.password");
        assert_eq!(item.rev, 12);
        assert!(!item.deleted);
    }

    #[test]
    fn pull_response_tolerates_missing_fields() {
        // A server that returns no items and only latest_rev still parses.
        let json = serde_json::json!({ "latest_rev": 5 });
        let pr: PullResponse = serde_json::from_value(json).unwrap();
        assert!(pr.items.is_empty());
        assert_eq!(pr.latest_rev, 5);
    }

    #[test]
    fn config_round_trips_through_json() {
        let mut cfg = AccountConfig::default();
        cfg.username = Some("alice".into());
        cfg.last_sync_rev = 42;
        cfg.item_revs.insert("__hostlist__".into(), 7);
        cfg.updated_at.insert("__hostlist__".into(), 1_700_000_000_000);
        let s = serde_json::to_string(&cfg).unwrap();
        let back: AccountConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.username.as_deref(), Some("alice"));
        assert_eq!(back.last_sync_rev, 42);
        assert_eq!(back.item_revs.get("__hostlist__"), Some(&7));
    }

    #[test]
    fn default_config_uses_default_server() {
        let cfg = AccountConfig::default();
        assert_eq!(cfg.server_url, DEFAULT_SERVER_URL);
        assert!(cfg.username.is_none());
        assert!(!cfg.did_initial_push);
    }

    // Two-key end-to-end mapping: simulate two vault entries → items → pull on a
    // fresh device decrypts them back to the same values.
    #[test]
    fn two_items_encrypt_and_decrypt_back() {
        let uk = fake_user_key();
        let entries = [
            ("__hostlist__", "[{\"id\":\"a\",\"host\":\"10.0.0.1\"}]"),
            ("host.a.password", "hunter2"),
        ];
        // Build the items as the server would store them.
        let mut server: Vec<RemoteItem> = Vec::new();
        for (i, (k, v)) in entries.iter().enumerate() {
            let ct = ac::encrypt_item(v.as_bytes(), &uk).unwrap();
            server.push(RemoteItem {
                item_id: k.to_string(),
                r#type: item_type_for_key(k).to_string(),
                ciphertext: B64.encode(&ct),
                rev: (i + 1) as u64,
                updated_at: Some(1000 + i as u64),
                deleted: false,
            });
        }
        // Pull-side apply (decrypt) — assert we recover the originals + types.
        for (item, (k, v)) in server.iter().zip(entries.iter()) {
            let ct = B64.decode(&item.ciphertext).unwrap();
            let pt = ac::decrypt_item(&ct, &uk).unwrap();
            assert_eq!(String::from_utf8(pt).unwrap(), *v);
            assert_eq!(item.r#type, item_type_for_key(k));
        }
    }
}
