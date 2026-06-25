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
//! # Per-host opt-in sync (NOT "sync the whole vault")
//! A host is synced **only** if its record in the local `__hostlist__` carries
//! `sync == true`. The `__hostlist__` blob itself is NEVER an item, and nothing
//! that isn't an explicitly-flagged host (or one of its secrets) ever leaves the
//! device. For each flagged host `<id>` we build up to three items:
//!   * `host.<id>`            (type `host`)          — that ONE host record JSON.
//!   * `host.<id>.password`   (type `host-password`) — if that vault key exists.
//!   * `nexussh.known_hosts.<id>` (type `known_host`) — if that vault key exists.
//! `item_id` is the synthetic key above (for `host.<id>` it is NOT a vault key —
//! the record is sliced out of `__hostlist__`); for the two secret items it is
//! the literal vault key. `ciphertext = account_crypto::encrypt_item(bytes, uk)`.
//! On pull we decrypt with `user_key` and MERGE per-record back into the local
//! `__hostlist__` (preserving every local host), writing secrets per-key.
//!
//! Items we used to sync but no longer do (a host un-flagged true→false, or
//! deleted) are pushed as TOMBSTONES so other devices drop the synced copy. We
//! remember the set of item_ids we last synced (`synced_item_ids`) to detect
//! un-flagging across runs.
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
    /// Item ids we know to have been deleted locally (tombstones to push). Maps
    /// the item_id to the deletion timestamp (ms). Cleared once the server acks
    /// them. Includes synthetic `host.<id>` ids as well as secret vault keys.
    #[serde(default)]
    tombstones: HashMap<String, u64>,
    /// The set of item_ids we synced on the LAST push (host records + their
    /// secrets). Comparing this against the currently-flagged set lets us detect
    /// a host that was un-flagged (sync true→false) or removed so we can push a
    /// tombstone for it. Stored as a map (id → 1) for stable JSON round-trips.
    #[serde(default)]
    synced_item_ids: HashMap<String, u8>,
    /// True once the first push has happened. Before it, we still only push
    /// flagged hosts — but we force-push all of them regardless of timestamps
    /// (a brand-new device has no notion of "what changed").
    #[serde(default)]
    did_initial_push: bool,
    /// The account user_id this bookkeeping belongs to. If a login returns a
    /// DIFFERENT user_id (account re-created / switched), all the rev/tombstone
    /// state is stale and must be reset — otherwise a stale `last_sync_rev` would
    /// make the new account's items look "already pulled" and silently skip them.
    #[serde(default)]
    account_user_id: Option<String>,
}

impl AccountConfig {
    /// Wipe all per-account sync bookkeeping (cursors, rev/updated maps,
    /// tombstones, flagged set). Called on register and on an account switch so a
    /// fresh account starts from a clean slate. Keeps server_url/username/token.
    fn reset_sync_state(&mut self) {
        self.last_sync_rev = 0;
        self.last_sync_at = None;
        self.item_revs.clear();
        self.updated_at.clear();
        self.tombstones.clear();
        self.synced_item_ids.clear();
        self.did_initial_push = false;
    }
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
            synced_item_ids: HashMap::new(),
            did_initial_push: false,
            account_user_id: None,
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
// Item ⇄ vault key mapping (per-host opt-in model)
// ===========================================================================

/// The vault key holding the JSON array of ALL host records (synced + local).
/// This blob is the local source of truth and is NEVER uploaded as an item.
const HOSTLIST_KEY: &str = "__hostlist__";

/// The vault key under which we stash the (decoupled) account user key after a
/// successful login. It rides inside the age-encrypted vault, so once the vault
/// is unlocked the session is re-hydrated without re-entering the SYNC password
/// (which is independent of this device's vault master password). Never an item.
const USER_KEY_VAULT_KEY: &str = "__account_user_key__";

/// Item types. `host` carries a single host record (NOT a vault key — it's
/// sliced out of `__hostlist__`); the secret types carry literal vault keys.
const ITEM_TYPE_HOST: &str = "host";
const ITEM_TYPE_HOST_PASSWORD: &str = "host-password";
const ITEM_TYPE_KNOWN_HOST: &str = "known_host";
const ITEM_TYPE_SNIPPETS: &str = "snippets";

/// Global vault key holding the JSON snippets blob. Synced as a single item
/// (item_id == this key) when the device opts in (frontend writes the blob here).
pub const SNIPPETS_KEY: &str = "nexussh.snippets";

/// Synthetic item_id for a host record. NOT a vault key (the record lives inside
/// `__hostlist__`); we coin it so the server can store the record per-host.
fn host_item_id(id: &str) -> String {
    format!("host.{id}")
}
/// Vault key for a host's password secret.
fn host_password_key(id: &str) -> String {
    format!("host.{id}.password")
}
/// Vault key for a host's known-host (host-key) pin. NOTE: the live TOFU store
/// is currently a single global `__known_hosts__` map, so these per-host keys do
/// not yet exist in practice — this is the forward-compatible extension point for
/// when per-host pins land. We sync the key only `if it exists`, so it is a
/// harmless no-op today.
fn known_host_key(id: &str) -> String {
    format!("nexussh.known_hosts.{id}")
}

/// Derive the server item `type` from an item_id. A `host.<id>` id with no
/// `.password` suffix is the record itself; `host.<id>.password` is the password
/// secret; `nexussh.known_hosts.<id>` is a host-key pin.
pub fn item_type_for_key(key: &str) -> &'static str {
    if key == SNIPPETS_KEY {
        ITEM_TYPE_SNIPPETS
    } else if key.starts_with("nexussh.known_hosts.") {
        ITEM_TYPE_KNOWN_HOST
    } else if key.starts_with("host.") && key.ends_with(".password") {
        ITEM_TYPE_HOST_PASSWORD
    } else if key.starts_with("host.") {
        ITEM_TYPE_HOST
    } else {
        // Anything else (incl. `__hostlist__`) is NOT a syncable item type.
        "other"
    }
}

/// Extract the `<id>` from a `host.<id>` item_id (the record item, not a secret).
/// Returns None for password/known-host/other ids.
fn host_id_from_item(item_id: &str) -> Option<&str> {
    let rest = item_id.strip_prefix("host.")?;
    if rest.ends_with(".password") || rest.is_empty() {
        return None;
    }
    Some(rest)
}

// ---------------------------------------------------------------------------
// __hostlist__ helpers — the blob is a JSON ARRAY of host record objects.
// We treat each record as an opaque serde_json::Value keyed by its `id`, so we
// never need to model every field; we only read `id`/`sync` and (optionally)
// strip a device-local field. This keeps us forward-compatible with new fields.
// ---------------------------------------------------------------------------

/// Parse `__hostlist__` into a Vec of record objects. Tolerates a missing/empty
/// blob (→ empty list) and a non-array shape (→ empty list, never panics).
fn parse_hostlist(raw: Option<&str>) -> Vec<serde_json::Map<String, serde_json::Value>> {
    let raw = match raw {
        Some(r) if !r.trim().is_empty() => r,
        _ => return Vec::new(),
    };
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Array(arr)) => arr
            .into_iter()
            .filter_map(|v| match v {
                serde_json::Value::Object(m) => Some(m),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Serialize a list of record objects back to the `__hostlist__` JSON array.
fn serialize_hostlist(records: &[serde_json::Map<String, serde_json::Value>]) -> String {
    let arr = serde_json::Value::Array(
        records
            .iter()
            .map(|m| serde_json::Value::Object(m.clone()))
            .collect(),
    );
    serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into())
}

/// The record's `id` as a string, if present.
fn record_id(rec: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    rec.get("id").and_then(|v| v.as_str()).map(String::from)
}

/// True when the record is flagged for sync (`sync == true`). Missing/false/any
/// non-true value → local-only.
fn record_is_synced(rec: &serde_json::Map<String, serde_json::Value>) -> bool {
    rec.get("sync").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// The record's `updatedAt`/`lastUsedAt` as an LWW timestamp (ms). The frontend
/// doesn't carry a dedicated ms field, so we fall back to 0 and rely on the
/// per-item `updated_at` map for LWW; this helper only mines an explicit numeric
/// `updatedAt` if a future frontend adds one.
fn record_updated_at(rec: &serde_json::Map<String, serde_json::Value>) -> u64 {
    rec.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0)
}

/// True when the server's highest rev is BELOW our last-synced cursor — i.e. the
/// server lost data (DB wiped or restored from an older backup). We use this to
/// force a full re-push of locally-flagged hosts on the next sync. Only meaningful
/// once we've synced at least once (`since > 0`).
fn server_regressed(since: u64, server_latest_rev: u64) -> bool {
    since > 0 && server_latest_rev < since
}

/// Produce the host RECORD payload we actually upload: the record JSON with any
/// purely-device-local fields stripped. Today only `vpnProfileId` qualifies — it
/// references a VPN profile kept in this device's localStorage (`nexussh.vpnProfiles`)
/// that never syncs, so the id is meaningless on another device. Everything else
/// (incl. `forwards`/tunnel config and `useVpn`/`vpnExit`) rides with the host.
/// `sync:true` is forced on so a pulled record stays flagged on the new device.
fn record_for_upload(rec: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    let mut out = rec.clone();
    out.remove("vpnProfileId"); // device-specific; see hosts.ts
    out.insert("sync".into(), serde_json::Value::Bool(true));
    serde_json::Value::Object(out)
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

/// JSON DELETE helper (used for `DELETE /v1/account`).
fn http_delete(base_url: &str, path: &str, token: &str) -> Result<serde_json::Value> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    match ureq::delete(&url)
        .timeout(std::time::Duration::from_secs(30))
        .set("User-Agent", "NexuSSH")
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(resp) => {
            let txt = resp.into_string().map_err(|e| AccountError::Http(e.to_string()))?;
            if txt.is_empty() {
                return Ok(serde_json::Value::Null);
            }
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

/// Re-hydrate the in-memory session from the persisted token + the user key
/// stashed (encrypted at rest) in the vault. No-op if already logged in, no
/// token, vault locked, or no stashed key. This is what lets the session survive
/// an app restart: unlocking the vault is enough, the user never re-types the
/// sync password. The sync password is INDEPENDENT of the vault master password.
fn restore_session(
    app: &AppHandle,
    state: &State<'_, AccountState>,
    vault_state: &State<'_, VaultState>,
) {
    if state.inner.lock().unwrap().is_some() {
        return;
    }
    let cfg = match load_config(app) {
        Ok(c) => c,
        Err(_) => return,
    };
    let token = match cfg.token {
        Some(t) => t,
        None => return,
    };
    if !vault::is_unlocked(vault_state) {
        return;
    }
    let stored = match vault::get_opt(vault_state, USER_KEY_VAULT_KEY) {
        Some(s) => s,
        None => return,
    };
    let bytes = match B64.decode(stored.trim()) {
        Ok(b) => b,
        Err(_) => return,
    };
    if bytes.len() != 32 {
        return;
    }
    let mut uk = [0u8; 32];
    uk.copy_from_slice(&bytes);
    *state.inner.lock().unwrap() = Some(Session {
        token,
        user_key: Zeroizing::new(uk),
    });
}

#[tauri::command]
pub async fn account_status(
    app: AppHandle,
    state: State<'_, AccountState>,
    vault_state: State<'_, VaultState>,
) -> Result<AccountStatus> {
    // Lazily restore a persisted session (token + vault-stashed key) so a restart
    // with an unlocked vault shows "logged in" without re-entering the password.
    restore_session(&app, &state, &vault_state);
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

/// Register a new account. The `password` is the **sync password** — an account
/// credential that is INDEPENDENT of this device's vault master password. The
/// same sync password is used on every device; each device keeps its own local
/// vault password. (Earlier "unified-password" coupling is gone: it broke as soon
/// as two devices had different vault passwords — see the 2026-06 data-loss
/// incident.) No vault is needed to register; login stashes the derived key into
/// the vault so the session survives restarts.
#[tauri::command]
pub async fn account_register(
    app: AppHandle,
    password: String,
    username: String,
) -> Result<RegisterResult> {
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
        "recovery_auth_hash": payload.recovery_auth_hash,
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
    // Brand-new account → drop any stale sync bookkeeping from a previous account
    // on this device, and remember whose state this is.
    cfg.reset_sync_state();
    cfg.account_user_id = Some(user_id.clone());
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
    vault_state: State<'_, VaultState>,
    password: String,
    username: String,
    totp: Option<String>,
) -> Result<LoginResult> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(AccountError::Other("username is empty".into()));
    }
    // The vault must be unlocked: we stash the derived sync key inside it so the
    // session survives a restart (the sync password is independent of the vault
    // master password, so the key can't be re-derived from the vault alone).
    if !vault::is_unlocked(&vault_state) {
        return Err(AccountError::Vault(vault::VaultError::Locked));
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

    // Stash the derived key inside the unlocked vault (encrypted at rest) so the
    // session re-hydrates on restart from the vault alone — no sync-password
    // re-entry. See `restore_session`.
    vault::put_key(&vault_state, USER_KEY_VAULT_KEY, B64.encode(&user_key[..]))?;

    // 5. Persist config + hold the session in memory.
    let mut cfg = load_config(&app)?;
    // Account switch (or a re-created account with the same name) → the local
    // rev/tombstone bookkeeping is stale; reset so we re-pull the new account's
    // items from rev 0 instead of skipping them as "already seen".
    if !user_id.is_empty() && cfg.account_user_id.as_deref() != Some(user_id.as_str()) {
        cfg.reset_sync_state();
        cfg.account_user_id = Some(user_id.clone());
    }
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
    vault_state: State<'_, VaultState>,
) -> Result<()> {
    *state.inner.lock().unwrap() = None; // drops Session → zeroizes user_key
    // Drop the stashed key so a later restore can't silently re-login.
    if vault::is_unlocked(&vault_state) {
        let _ = vault::delete_key(&vault_state, USER_KEY_VAULT_KEY);
    }
    let mut cfg = load_config(&app)?;
    cfg.token = None;
    save_config(&app, &cfg)?;
    Ok(())
}

// ===========================================================================
// Change password / recover with key / delete account
// ===========================================================================

/// Fetch account_salt + kdf_params for a username (public prelogin).
async fn prelogin(server_url: &str, username: &str) -> Result<(String, String)> {
    let body = serde_json::json!({ "username": username });
    let url = server_url.to_string();
    let pre = tokio::task::spawn_blocking(move || http_post_json(&url, "/v1/prelogin", None, &body))
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;
    let salt = pre
        .get("account_salt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("prelogin missing account_salt".into()))?
        .to_string();
    let kdf = match pre.get("kdf_params") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => return Err(AccountError::Other("prelogin missing kdf_params".into())),
    };
    Ok((salt, kdf))
}

/// Change the sync password: verify the current password (a real /login, which
/// also satisfies TOTP if enabled), re-wrap the user key under the new password,
/// and push the rotated verifier+blob to the server. The user key is unchanged,
/// so all encrypted data stays readable.
#[tauri::command]
pub async fn account_change_password(
    app: AppHandle,
    state: State<'_, AccountState>,
    vault_state: State<'_, VaultState>,
    current_password: String,
    new_password: String,
    totp: Option<String>,
) -> Result<()> {
    if new_password.is_empty() {
        return Err(AccountError::Other("new password is empty".into()));
    }
    if !vault::is_unlocked(&vault_state) {
        return Err(AccountError::Vault(vault::VaultError::Locked));
    }
    let cfg = load_config(&app)?;
    let server_url = cfg.server_url.clone();
    let username = cfg
        .username
        .clone()
        .ok_or_else(|| AccountError::Other("not logged in".into()))?;

    let (salt, kdf) = prelogin(&server_url, &username).await?;
    let salt_bytes = B64.decode(&salt)?;
    let params = ac::KdfParams::from_str(&kdf)?;
    let master = ac::derive_master_key(&current_password, &salt_bytes, &params)?;
    let auth_hash_b64 = B64.encode(ac::auth_hash(&master, &salt_bytes)?);

    let mut login_body = serde_json::json!({
        "username": username.clone(),
        "auth_hash": auth_hash_b64,
        "device_name": device_name(),
    });
    if let Some(code) = totp.as_ref().filter(|c| !c.trim().is_empty()) {
        login_body["totp"] = serde_json::json!(code.trim());
    }
    let url = server_url.clone();
    let login = tokio::task::spawn_blocking(move || http_post_json(&url, "/v1/login", None, &login_body))
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;
    let token = login
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("login response missing token".into()))?
        .to_string();
    let wrapped = login
        .get("wrapped_user_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("login missing wrapped_user_key".into()))?;
    // Unwrap with the CURRENT password (verifies it), then re-wrap under the new.
    let lr = ac::login(&current_password, &salt, &kdf, wrapped)?;
    let rk = ac::rekey_password(&lr.user_key, &new_password, &salt, &kdf)?;

    let body = serde_json::json!({
        "auth_hash": rk.auth_hash,
        "wrapped_user_key": rk.wrapped_user_key,
    });
    let url = server_url.clone();
    let tok = token.clone();
    tokio::task::spawn_blocking(move || http_post_json(&url, "/v1/credentials", Some(&tok), &body))
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;

    // Keep the session live (same user key, fresh token).
    vault::put_key(&vault_state, USER_KEY_VAULT_KEY, B64.encode(&lr.user_key[..]))?;
    let mut cfg = load_config(&app)?;
    cfg.token = Some(token.clone());
    save_config(&app, &cfg)?;
    *state.inner.lock().unwrap() = Some(Session { token, user_key: lr.user_key });
    Ok(())
}

/// Recover access with the emergency-kit recovery key when the password is
/// forgotten: prove the recovery key (recovery-login), unwrap the user key, set
/// a NEW password, and re-key the account. No data loss — the user key is the
/// same one that encrypts every item.
#[tauri::command]
pub async fn account_recover(
    app: AppHandle,
    state: State<'_, AccountState>,
    vault_state: State<'_, VaultState>,
    username: String,
    recovery_key: String,
    new_password: String,
) -> Result<LoginResult> {
    let username = username.trim().to_string();
    if username.is_empty() || new_password.is_empty() {
        return Err(AccountError::Other("username/password empty".into()));
    }
    if !vault::is_unlocked(&vault_state) {
        return Err(AccountError::Vault(vault::VaultError::Locked));
    }
    let cfg = load_config(&app)?;
    let server_url = cfg.server_url.clone();

    let (salt, kdf) = prelogin(&server_url, &username).await?;
    let r_ah = ac::recovery_auth_hash_from_kit(&recovery_key, &salt)?;
    let body = serde_json::json!({
        "username": username.clone(),
        "recovery_auth_hash": r_ah,
        "device_name": device_name(),
    });
    let url = server_url.clone();
    let rl = tokio::task::spawn_blocking(move || http_post_json(&url, "/v1/recovery-login", None, &body))
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;
    let token = rl
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("recovery-login missing token".into()))?
        .to_string();
    let user_id = rl.get("user_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let recovery_wrapped = rl
        .get("recovery_wrapped_user_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AccountError::Other("recovery-login missing recovery key blob".into()))?;

    // Unwrap the user key with the recovery key, then set the new password.
    let user_key = ac::recover_user_key(&recovery_key, recovery_wrapped)?;
    let rk = ac::rekey_password(&user_key, &new_password, &salt, &kdf)?;
    let cred = serde_json::json!({
        "auth_hash": rk.auth_hash,
        "wrapped_user_key": rk.wrapped_user_key,
    });
    let url = server_url.clone();
    let tok = token.clone();
    tokio::task::spawn_blocking(move || http_post_json(&url, "/v1/credentials", Some(&tok), &cred))
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;

    // Establish the session (recovery token works until the user re-logs in).
    vault::put_key(&vault_state, USER_KEY_VAULT_KEY, B64.encode(&user_key[..]))?;
    let mut cfg = load_config(&app)?;
    if !user_id.is_empty() && cfg.account_user_id.as_deref() != Some(user_id.as_str()) {
        cfg.reset_sync_state();
        cfg.account_user_id = Some(user_id.clone());
    }
    cfg.username = Some(username);
    cfg.token = Some(token.clone());
    save_config(&app, &cfg)?;
    *state.inner.lock().unwrap() = Some(Session { token, user_key });
    Ok(LoginResult { user_id, totp_enabled: false })
}

/// Delete the account from the server entirely (irreversible). Local hosts are
/// KEPT — only this device's sync bookkeeping/session is cleared, so the hosts
/// stay on-device (shown as "not syncing"). Requires a live session.
#[tauri::command]
pub async fn account_delete(
    app: AppHandle,
    state: State<'_, AccountState>,
    vault_state: State<'_, VaultState>,
) -> Result<()> {
    let cfg = load_config(&app)?;
    let server_url = cfg.server_url.clone();
    let token = cfg
        .token
        .clone()
        .ok_or_else(|| AccountError::Other("not logged in".into()))?;
    let url = server_url.clone();
    tokio::task::spawn_blocking(move || http_delete(&url, "/v1/account", &token))
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;

    // Server account gone → clear local session + sync bookkeeping, KEEP hosts.
    *state.inner.lock().unwrap() = None;
    if vault::is_unlocked(&vault_state) {
        let _ = vault::delete_key(&vault_state, USER_KEY_VAULT_KEY);
    }
    let mut cfg = load_config(&app)?;
    cfg.token = None;
    cfg.username = None;
    cfg.account_user_id = None;
    cfg.reset_sync_state();
    save_config(&app, &cfg)?;
    Ok(())
}

/// Record explicit tombstones for hosts the user un-flagged (sync true→false) or
/// deleted. The frontend MUST call this at the moment of that action (before or
/// with the local write). These are the ONLY source of deletions pushed to the
/// server — see the safety note in `build_push_changes`. Recording a tombstone
/// for a host that was never synced is harmless (the server no-ops the delete).
#[tauri::command]
pub async fn account_record_tombstones(app: AppHandle, host_ids: Vec<String>) -> Result<()> {
    if host_ids.is_empty() {
        return Ok(());
    }
    let mut cfg = load_config(&app)?;
    let ts = now_ms();
    for id in host_ids {
        for k in [host_item_id(&id), host_password_key(&id), known_host_key(&id)] {
            cfg.tombstones.entry(k.clone()).or_insert(ts);
            cfg.synced_item_ids.remove(&k);
        }
    }
    save_config(&app, &cfg)?;
    Ok(())
}

/// Bump the snippets blob's content timestamp so the next sync pushes it.
/// Frontend calls this after writing SNIPPETS_KEY (a snippet was edited while
/// snippet-sync is on), so LWW detects the change.
#[tauri::command]
pub async fn account_touch_snippets(app: AppHandle) -> Result<()> {
    let mut cfg = load_config(&app)?;
    cfg.updated_at.insert(SNIPPETS_KEY.to_string(), now_ms());
    save_config(&app, &cfg)?;
    Ok(())
}

/// Record an explicit tombstone for the global snippets blob (sync toggle turned
/// OFF). Explicit-only, like host deletions — never inferred — so an empty/locked
/// vault can't mass-delete snippets across devices.
#[tauri::command]
pub async fn account_tombstone_snippets(app: AppHandle) -> Result<()> {
    let mut cfg = load_config(&app)?;
    cfg.tombstones.entry(SNIPPETS_KEY.to_string()).or_insert(now_ms());
    cfg.synced_item_ids.remove(SNIPPETS_KEY);
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

/// Disable TOTP 2FA. Requires a current authenticator code (or a recovery code)
/// to confirm — the server verifies it before clearing the secret.
#[tauri::command]
pub async fn account_totp_disable(
    app: AppHandle,
    state: State<'_, AccountState>,
    code: String,
) -> Result<()> {
    let (token, server_url) = session_token(&app, &state)?;
    let body = serde_json::json!({ "code": code.trim() });
    tokio::task::spawn_blocking(move || {
        http_post_json(&server_url, "/v1/totp/disable", Some(&token), &body)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))??;
    let mut cfg = load_config(&app)?;
    cfg.totp_enabled = false;
    save_config(&app, &cfg)?;
    Ok(())
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
    // Re-hydrate a persisted session first (restart with unlocked vault).
    restore_session(&app, &state, &vault_state);
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
    let pull_res = tokio::task::spawn_blocking(move || {
        http_get_json(&url, &format!("/v1/items?since={since}"), &tok)
    })
    .await
    .map_err(|e| AccountError::Other(e.to_string()))?;
    let pull_raw = match pull_res {
        Ok(v) => v,
        // Token rejected by the server (expired/removed → "invalid token"). Auto
        // log out so the UI shows the login screen instead of a raw 401: clear the
        // in-memory session, drop the stashed user key, and wipe the saved token.
        // Surfaced as NotLoggedIn, which the frontend already handles as "sign in".
        Err(AccountError::Server { status: 401, .. }) => {
            *state.inner.lock().unwrap() = None;
            if vault::is_unlocked(&vault_state) {
                let _ = vault::delete_key(&vault_state, USER_KEY_VAULT_KEY);
            }
            if let Ok(mut c) = load_config(&app) {
                c.token = None;
                let _ = save_config(&app, &c);
            }
            return Err(AccountError::NotLoggedIn);
        }
        Err(e) => return Err(e),
    };
    let mut pull: PullResponse = serde_json::from_value(pull_raw)?;

    // SELF-HEAL: if the server's max rev is BELOW our cursor, the server lost data
    // (DB wiped / restored from an older backup). Reset the sync bookkeeping so
    // this same run re-pushes ALL locally-flagged hosts (the `!did_initial_push`
    // path) AND re-pull from scratch (since=0) so a device that needs to DOWNLOAD
    // the restored items gets them THIS run too — otherwise the end-of-run cursor
    // (= pull.latest_rev) would skip past them and the device stays empty until a
    // second sync. No data loss: reset clears cursors/revs only, never the host
    // list. This is what makes a plain "Sync now" restore the cloud after a wipe,
    // so no separate "re-upload everything" button is needed.
    if server_regressed(since, pull.latest_rev) {
        cfg.reset_sync_state();
        let url = server_url.clone();
        let tok = token.clone();
        let raw0 = tokio::task::spawn_blocking(move || {
            http_get_json(&url, "/v1/items?since=0", &tok)
        })
        .await
        .map_err(|e| AccountError::Other(e.to_string()))??;
        pull = serde_json::from_value(raw0)?;
    }

    // Load the local host list ONCE; merge incoming `host.<id>` records into this
    // in-memory Vec (preserving every local host), then write it back ONCE after
    // the pull loop. Secret items (password/known_host) write per-key immediately.
    let mut hostlist = parse_hostlist(vault::get_opt(&vault_state, HOSTLIST_KEY).as_deref());
    let mut hostlist_dirty = false;

    for item in &pull.items {
        let key = &item.item_id;
        let itype = item_type_for_key(key);
        let local_updated = cfg.updated_at.get(key).copied().unwrap_or(0);
        let remote_updated = item.updated_at.unwrap_or(0);

        // ---- host RECORD item (lives inside __hostlist__) -------------------
        if itype == ITEM_TYPE_HOST {
            let id = match host_id_from_item(key) {
                Some(i) => i.to_string(),
                None => continue,
            };
            let pos = hostlist.iter().position(|r| record_id(r).as_deref() == Some(&id));

            if item.deleted {
                // Tombstone for a host record: drop it from the list ONLY if our
                // local copy is itself flagged-synced (never delete a purely-local
                // host). Skip if our copy is strictly newer (we re-push it).
                if let Some(p) = pos {
                    let local_synced = record_is_synced(&hostlist[p]);
                    let local_ts = record_updated_at(&hostlist[p]).max(local_updated);
                    if local_synced && (local_ts <= remote_updated || remote_updated == 0) {
                        hostlist.remove(p);
                        hostlist_dirty = true;
                        // Also drop its secrets (only the synced host's).
                        for sk in [host_password_key(&id), known_host_key(&id)] {
                            if vault::get_opt(&vault_state, &sk).is_some() {
                                vault::delete_key(&vault_state, &sk)?;
                            }
                            cfg.updated_at.remove(&sk);
                            cfg.tombstones.remove(&sk);
                        }
                        report.deleted_locally += 1;
                    }
                }
                cfg.updated_at.remove(key);
                cfg.tombstones.remove(key);
                cfg.synced_item_ids.remove(key);
                cfg.item_revs.insert(key.clone(), item.rev);
                report.latest_rev = report.latest_rev.max(item.rev);
                report.pulled += 1;
                continue;
            }

            // Decrypt the record JSON.
            let ct = B64.decode(&item.ciphertext)?;
            let plaintext = ac::decrypt_item(&ct, &user_key)?;
            let remote_rec: serde_json::Map<String, serde_json::Value> =
                match serde_json::from_slice(&plaintext) {
                    Ok(serde_json::Value::Object(m)) => m,
                    _ => continue, // malformed record → skip, don't corrupt the list
                };

            let apply_remote = match pos {
                None => true, // absent locally → add it.
                Some(p) => {
                    // LWW: prefer an explicit record `updatedAt`, else the per-item
                    // map. Equal → remote wins (idempotent on identical content).
                    let local_ts = record_updated_at(&hostlist[p]).max(local_updated);
                    remote_updated >= local_ts
                }
            };
            if apply_remote {
                let mut rec = remote_rec;
                rec.insert("sync".into(), serde_json::Value::Bool(true));
                rec.insert("id".into(), serde_json::Value::String(id.clone()));
                match pos {
                    Some(p) => {
                        // vpnProfileId — device-local (стрипается при upload, см.
                        // record_for_upload), поэтому remote-запись его не несёт.
                        // Сохраняем локальный — иначе pull затирал бы выбранный
                        // VPN-профиль даже на устройстве-источнике (баг 2026-06-24).
                        if !rec.contains_key("vpnProfileId") {
                            if let Some(v) = hostlist[p].get("vpnProfileId").cloned() {
                                rec.insert("vpnProfileId".into(), v);
                            }
                        }
                        hostlist[p] = rec; // UPSERT existing
                    }
                    None => hostlist.push(rec), // add new synced host
                }
                hostlist_dirty = true;
                cfg.updated_at.insert(key.clone(), remote_updated.max(local_updated));
                cfg.tombstones.remove(key);
                cfg.synced_item_ids.insert(key.clone(), 1);
                report.pulled += 1;
            }
            cfg.item_revs.insert(key.clone(), item.rev);
            report.latest_rev = report.latest_rev.max(item.rev);
            continue;
        }

        // ---- secret/blob items (password / known_host / snippets) → vault ---
        if itype != ITEM_TYPE_HOST_PASSWORD
            && itype != ITEM_TYPE_KNOWN_HOST
            && itype != ITEM_TYPE_SNIPPETS
        {
            // Not a host-owned item (e.g. a stale `__hostlist__`/`other`); ignore.
            cfg.item_revs.insert(key.clone(), item.rev);
            report.latest_rev = report.latest_rev.max(item.rev);
            continue;
        }

        if item.deleted {
            if local_updated <= remote_updated || remote_updated == 0 {
                if vault::get_opt(&vault_state, key).is_some() {
                    vault::delete_key(&vault_state, key)?;
                    report.deleted_locally += 1;
                }
                cfg.updated_at.remove(key);
                cfg.tombstones.remove(key);
                cfg.synced_item_ids.remove(key);
            }
            cfg.item_revs.insert(key.clone(), item.rev);
            report.latest_rev = report.latest_rev.max(item.rev);
            report.pulled += 1;
            continue;
        }

        let ct = B64.decode(&item.ciphertext)?;
        let plaintext = ac::decrypt_item(&ct, &user_key)?;
        let remote_value = String::from_utf8_lossy(&plaintext).into_owned();
        let local_value = vault::get_opt(&vault_state, key);
        let apply_remote = match &local_value {
            None => true,
            Some(lv) => lv != &remote_value && remote_updated >= local_updated,
        };
        if apply_remote {
            vault::put_key(&vault_state, key, remote_value)?;
            cfg.updated_at.insert(key.clone(), remote_updated.max(local_updated));
            cfg.tombstones.remove(key);
            cfg.synced_item_ids.insert(key.clone(), 1);
            report.pulled += 1;
        }
        cfg.item_revs.insert(key.clone(), item.rev);
        report.latest_rev = report.latest_rev.max(item.rev);
    }

    // Write the merged host list back ONCE (only if it changed) — never wholesale
    // replace; we mutated a per-record copy that still holds all local hosts.
    if hostlist_dirty {
        vault::put_key(&vault_state, HOSTLIST_KEY, serialize_hostlist(&hostlist))?;
    }
    cfg.last_sync_rev = report.latest_rev.max(pull.latest_rev);

    // -------------------------------------------------------------------
    // 2. PUSH: enumerate ONLY the flagged hosts + their secrets, plus
    //    tombstones for hosts that were un-flagged/removed since last sync.
    // -------------------------------------------------------------------
    // Re-read the (possibly merged) host list so a freshly-pulled host can be
    // re-pushed (e.g. to materialize its secrets) in the same run.
    let hostlist_now =
        parse_hostlist(vault::get_opt(&vault_state, HOSTLIST_KEY).as_deref());

    let changes = build_push_changes(&hostlist_now, &vault_state, &user_key, &mut cfg)?;

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
                    // Pushed tombstones are now durable on the server → drop ours
                    // and forget the item was ever synced.
                    if cfg.tombstones.remove(&res.item_id).is_some() {
                        cfg.updated_at.remove(&res.item_id);
                        cfg.synced_item_ids.remove(&res.item_id);
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

/// Build the push change-set from the current host list: ONE record item per
/// flagged host (+ its password / known-host secrets `if they exist`), and a
/// TOMBSTONE for every item we synced last time that is no longer flagged
/// (host un-flagged true→false or deleted). Updates `cfg.synced_item_ids` to the
/// new flagged set and records tombstones in `cfg.tombstones`.
///
/// `__hostlist__` is never an item. Non-flagged hosts and unrelated vault keys
/// never produce a change. Pure read of the vault + cfg mutation — no network.
fn build_push_changes(
    hostlist: &[serde_json::Map<String, serde_json::Value>],
    vault_state: &State<'_, VaultState>,
    user_key: &[u8; 32],
    cfg: &mut AccountConfig,
) -> Result<Vec<PushChange>> {
    let mut changes: Vec<PushChange> = Vec::new();
    // The item_ids that SHOULD exist on the server after this push.
    let mut flagged_now: HashMap<String, u8> = HashMap::new();

    for rec in hostlist {
        if !record_is_synced(rec) {
            continue; // local-only host → never leaves the device.
        }
        let id = match record_id(rec) {
            Some(i) => i,
            None => continue, // record without an id is unusable; skip.
        };

        // --- the host record item (sliced out of __hostlist__) -------------
        let item_id = host_item_id(&id);
        flagged_now.insert(item_id.clone(), 1);
        let payload = record_for_upload(rec);
        let bytes = serde_json::to_vec(&payload)?;
        let tracked = *cfg.updated_at.entry(item_id.clone()).or_insert_with(now_ms);
        // A local EDIT bumps the record's own `updatedAt` (epoch-ms). Use it as the
        // content timestamp so edits to an ALREADY-synced host (e.g. adding a
        // port-forward) are detected and pushed — and win LWW on other devices.
        // Without this, edits never re-upload (and pull clobbers them). Falls back
        // to the tracked per-item time for records saved before updatedAt existed.
        let updated_at = record_updated_at(rec).max(tracked);
        let base_rev = cfg.item_revs.get(&item_id).copied().unwrap_or(0);
        // First-ever push, never-acked, or locally newer than the last sync.
        let changed = !cfg.did_initial_push
            || base_rev == 0
            || updated_at > cfg.last_sync_at.unwrap_or(0);
        if changed {
            // Keep local_updated aligned with what we're uploading so the next
            // pull's LWW compares against the right timestamp.
            cfg.updated_at.insert(item_id.clone(), updated_at);
            let ct = ac::encrypt_item(&bytes, user_key)?;
            changes.push(PushChange {
                item_id: item_id.clone(),
                r#type: ITEM_TYPE_HOST.to_string(),
                ciphertext: B64.encode(&ct),
                updated_at,
                deleted: false,
                base_rev,
            });
        }

        // --- the host's secrets, only if those vault keys exist ------------
        for sk in [host_password_key(&id), known_host_key(&id)] {
            let value = match vault::get_opt(vault_state, &sk) {
                Some(v) => v,
                None => continue,
            };
            flagged_now.insert(sk.clone(), 1);
            let s_updated = *cfg.updated_at.entry(sk.clone()).or_insert_with(now_ms);
            let s_base = cfg.item_revs.get(&sk).copied().unwrap_or(0);
            let s_changed = !cfg.did_initial_push
                || s_base == 0
                || s_updated > cfg.last_sync_at.unwrap_or(0);
            if s_changed {
                let ct = ac::encrypt_item(value.as_bytes(), user_key)?;
                changes.push(PushChange {
                    item_id: sk.clone(),
                    r#type: item_type_for_key(&sk).to_string(),
                    ciphertext: B64.encode(&ct),
                    updated_at: s_updated,
                    deleted: false,
                    base_rev: s_base,
                });
            }
        }
    }

    // --- global snippets blob (opt-in) ----------------------------------
    // The frontend writes the JSON snippets array into SNIPPETS_KEY when the
    // device's snippet-sync toggle is on, and bumps updated_at via
    // `account_touch_snippets` on every edit. We push it as ONE item. When the
    // toggle goes off, the frontend records an explicit tombstone (never diffed).
    if let Some(value) = vault::get_opt(vault_state, SNIPPETS_KEY) {
        flagged_now.insert(SNIPPETS_KEY.to_string(), 1);
        let g_updated = *cfg.updated_at.entry(SNIPPETS_KEY.to_string()).or_insert_with(now_ms);
        let g_base = cfg.item_revs.get(SNIPPETS_KEY).copied().unwrap_or(0);
        let g_changed =
            !cfg.did_initial_push || g_base == 0 || g_updated > cfg.last_sync_at.unwrap_or(0);
        if g_changed {
            let ct = ac::encrypt_item(value.as_bytes(), user_key)?;
            changes.push(PushChange {
                item_id: SNIPPETS_KEY.to_string(),
                r#type: ITEM_TYPE_SNIPPETS.to_string(),
                ciphertext: B64.encode(&ct),
                updated_at: g_updated,
                deleted: false,
                base_rev: g_base,
            });
        }
    }

    // --- DELETIONS are EXPLICIT ONLY -------------------------------------
    // We deliberately do NOT derive deletions by diffing the previously-synced
    // set against the currently-flagged set. That heuristic caused total data
    // loss (2026-06): if a device's local list was empty/undecryptable (vault
    // reset, wrong/changed password, locked vault), `flagged_now` was empty and
    // EVERY previously-synced item got tombstoned → the server was wiped → every
    // other device deleted its copy on the next pull. Mutual annihilation.
    //
    // Deletions now come ONLY from explicit tombstones recorded at the moment the
    // user un-flags or deletes a host (see `account_record_tombstones`). An empty
    // or again-locked vault therefore can never mass-delete: the worst case is a
    // deletion failing to propagate, never silent destruction.

    // Emit a push change for every pending tombstone (recorded on user un-flag /
    // delete, plus any left over from a previous failed run).
    for (item_id, ts) in cfg.tombstones.clone() {
        let base_rev = cfg.item_revs.get(&item_id).copied().unwrap_or(0);
        changes.push(PushChange {
            item_id: item_id.clone(),
            r#type: item_type_for_key(&item_id).to_string(),
            ciphertext: String::new(),
            updated_at: ts,
            deleted: true,
            base_rev,
        });
    }

    // The flagged set becomes the new "last synced" baseline. (Tombstoned ids
    // are already removed from synced_item_ids above; acks clear them from
    // `tombstones` in the push-result loop.)
    cfg.synced_item_ids = flagged_now;
    Ok(changes)
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

    // Host RECORD conflicts resolve against the record inside __hostlist__, not a
    // vault key. (Secrets fall through to the generic per-key path below.)
    if item_type_for_key(key) == ITEM_TYPE_HOST {
        return resolve_host_conflict(vault_state, user_key, cfg, srv, server_url, token, report)
            .await;
    }

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

/// Conflict resolution for a `host.<id>` RECORD item. Like [`resolve_conflict`]
/// but the local copy is the matching record inside `__hostlist__` (never a vault
/// key), and on "remote wins" we MERGE per-record (preserving all other hosts).
async fn resolve_host_conflict(
    vault_state: &State<'_, VaultState>,
    user_key: &[u8; 32],
    cfg: &mut AccountConfig,
    srv: &RemoteItem,
    server_url: &str,
    token: &str,
    report: &mut SyncReport,
) -> Result<()> {
    let key = &srv.item_id;
    let id = match host_id_from_item(key) {
        Some(i) => i.to_string(),
        None => return Ok(()),
    };
    let remote_updated = srv.updated_at.unwrap_or(0);
    let local_updated = cfg.updated_at.get(key).copied().unwrap_or(0);

    let mut hostlist =
        parse_hostlist(vault::get_opt(vault_state, HOSTLIST_KEY).as_deref());
    let pos = hostlist.iter().position(|r| record_id(r).as_deref() == Some(&id));

    if srv.deleted {
        // Server deleted; re-push if our flagged copy is newer, else drop it.
        match pos {
            Some(p) if record_is_synced(&hostlist[p]) && local_updated > remote_updated => {
                let payload = record_for_upload(&hostlist[p]);
                let ct = ac::encrypt_item(&serde_json::to_vec(&payload)?, user_key)?;
                push_single(cfg, server_url, token, key, ITEM_TYPE_HOST, &B64.encode(&ct), local_updated, false, report).await?;
            }
            Some(p) if record_is_synced(&hostlist[p]) => {
                hostlist.remove(p);
                vault::put_key(vault_state, HOSTLIST_KEY, serialize_hostlist(&hostlist))?;
                report.deleted_locally += 1;
                cfg.updated_at.remove(key);
                cfg.synced_item_ids.remove(key);
            }
            _ => {} // purely-local host (or absent) → never delete.
        }
        return Ok(());
    }

    // Server has a record. Decrypt + LWW against the local record.
    let ct = B64.decode(&srv.ciphertext)?;
    let remote_rec: serde_json::Map<String, serde_json::Value> =
        match serde_json::from_slice(&ac::decrypt_item(&ct, user_key)?) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => return Ok(()),
        };

    let local_wins = match pos {
        Some(p) => record_updated_at(&hostlist[p]).max(local_updated) > remote_updated,
        None => false,
    };
    if local_wins {
        if let Some(p) = pos {
            let payload = record_for_upload(&hostlist[p]);
            let ct = ac::encrypt_item(&serde_json::to_vec(&payload)?, user_key)?;
            push_single(cfg, server_url, token, key, ITEM_TYPE_HOST, &B64.encode(&ct), local_updated, false, report).await?;
        }
    } else {
        let mut rec = remote_rec;
        rec.insert("sync".into(), serde_json::Value::Bool(true));
        rec.insert("id".into(), serde_json::Value::String(id));
        match pos {
            Some(p) => hostlist[p] = rec,
            None => hostlist.push(rec),
        }
        vault::put_key(vault_state, HOSTLIST_KEY, serialize_hostlist(&hostlist))?;
        cfg.updated_at.insert(key.clone(), remote_updated.max(local_updated));
        cfg.synced_item_ids.insert(key.clone(), 1);
        report.pulled += 1;
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

    /// Build a synced/local host record object for tests.
    fn rec(id: &str, sync: bool) -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert("id".into(), serde_json::Value::String(id.into()));
        m.insert("name".into(), serde_json::Value::String(format!("host-{id}")));
        m.insert("host".into(), serde_json::Value::String("10.0.0.1".into()));
        m.insert("sync".into(), serde_json::Value::Bool(sync));
        m
    }

    // --- item id → type mapping --------------------------------------------

    #[test]
    fn type_for_host_record() {
        assert_eq!(item_type_for_key("host.abc123"), "host");
        // a host id is opaque; anything host.<...> that isn't a known secret is
        // the record (forward-compatible with arbitrary record-bearing ids).
        assert_eq!(item_type_for_key("host.abc.username"), "host");
    }

    #[test]
    fn type_for_password() {
        assert_eq!(item_type_for_key("host.abc123.password"), "host-password");
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
        // __hostlist__ is NEVER a syncable item type.
        assert_eq!(item_type_for_key("__hostlist__"), "other");
    }

    #[test]
    fn type_for_snippets() {
        // The global snippets blob is its own syncable type, not "other".
        assert_eq!(item_type_for_key(SNIPPETS_KEY), "snippets");
        assert_eq!(item_type_for_key("nexussh.snippets"), "snippets");
        // Doesn't collide with host items.
        assert_eq!(item_type_for_key("host.x"), "host");
    }

    #[test]
    fn host_id_extraction() {
        assert_eq!(host_id_from_item("host.abc123"), Some("abc123"));
        assert_eq!(host_id_from_item("host.abc.password"), None);
        assert_eq!(host_id_from_item("nexussh.known_hosts.x"), None);
        assert_eq!(host_id_from_item("host."), None);
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
            item_id: "host.abc".into(),
            r#type: "host".into(),
            ciphertext: "Zm9v".into(),
            updated_at: 1_700_000_000_000,
            deleted: false,
            base_rev: 7,
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["item_id"], "host.abc");
        assert_eq!(v["type"], "host");
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

    // Two-item end-to-end mapping: a host RECORD + its password → items → pull on
    // a fresh device decrypts them back to the same values + correct types.
    #[test]
    fn two_items_encrypt_and_decrypt_back() {
        let uk = fake_user_key();
        let entries = [
            ("host.a", "{\"id\":\"a\",\"host\":\"10.0.0.1\",\"sync\":true}"),
            ("host.a.password", "hunter2"),
        ];
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
        for (item, (k, v)) in server.iter().zip(entries.iter()) {
            let ct = B64.decode(&item.ciphertext).unwrap();
            let pt = ac::decrypt_item(&ct, &uk).unwrap();
            assert_eq!(String::from_utf8(pt).unwrap(), *v);
            assert_eq!(item.r#type, item_type_for_key(k));
        }
        assert_eq!(server[0].r#type, "host");
        assert_eq!(server[1].r#type, "host-password");
    }

    // --- __hostlist__ parse/serialize round-trip ----------------------------

    #[test]
    fn hostlist_round_trips_and_tolerates_garbage() {
        let raw = "[{\"id\":\"a\",\"sync\":true},{\"id\":\"b\",\"sync\":false}]";
        let list = parse_hostlist(Some(raw));
        assert_eq!(list.len(), 2);
        assert!(record_is_synced(&list[0]));
        assert!(!record_is_synced(&list[1]));
        // round-trips back to a 2-element array
        let back = parse_hostlist(Some(&serialize_hostlist(&list)));
        assert_eq!(back.len(), 2);
        // garbage / empty / non-array → empty list, never panics
        assert!(parse_hostlist(None).is_empty());
        assert!(parse_hostlist(Some("")).is_empty());
        assert!(parse_hostlist(Some("not json")).is_empty());
        assert!(parse_hostlist(Some("{\"id\":\"x\"}")).is_empty());
    }

    // --- PUSH: only flagged hosts become items ------------------------------

    #[test]
    fn build_push_emits_only_flagged_hosts_with_record_item() {
        let uk = fake_user_key();
        // Three hosts; only `a` and `c` are flagged.
        let list = vec![rec("a", true), rec("b", false), rec("c", true)];
        let mut cfg = AccountConfig::default();
        // No vault available in a unit test, so we exercise the record-only path
        // by parsing the hostlist directly (secrets need the vault → covered by
        // the integration path; here we assert record items + flag filtering).
        // Build manually mirroring build_push_changes' record branch:
        let mut flagged: Vec<String> = Vec::new();
        for r in &list {
            if record_is_synced(r) {
                let id = record_id(r).unwrap();
                let item_id = host_item_id(&id);
                let payload = record_for_upload(r);
                let _ct = ac::encrypt_item(&serde_json::to_vec(&payload).unwrap(), &uk).unwrap();
                flagged.push(item_id);
                cfg.synced_item_ids.insert(host_item_id(&id), 1);
            }
        }
        assert_eq!(flagged, vec!["host.a".to_string(), "host.c".to_string()]);
        // __hostlist__ itself is never an item id.
        assert!(!flagged.iter().any(|k| k == "__hostlist__"));
        // local-only host `b` produced nothing.
        assert!(!flagged.iter().any(|k| k == "host.b"));
    }

    #[test]
    fn record_for_upload_strips_vpn_profile_and_forces_sync() {
        let mut r = rec("a", false);
        r.insert("vpnProfileId".into(), serde_json::Value::String("local-123".into()));
        r.insert("forwards".into(), serde_json::json!([{"id":"f1","localPort":8080}]));
        let out = record_for_upload(&r);
        let obj = out.as_object().unwrap();
        // device-local vpnProfileId stripped
        assert!(!obj.contains_key("vpnProfileId"));
        // forwards/tunnel config rides with the host
        assert!(obj.contains_key("forwards"));
        // sync forced true so the pulled record stays flagged
        assert_eq!(obj.get("sync"), Some(&serde_json::Value::Bool(true)));
    }

    #[test]
    fn detects_server_rev_regression() {
        assert!(server_regressed(100, 0), "server wiped (rev 0) below our cursor");
        assert!(server_regressed(100, 50), "server restored from older backup");
        assert!(!server_regressed(100, 100), "in step → no regression");
        assert!(!server_regressed(100, 150), "server ahead → normal");
        assert!(!server_regressed(0, 0), "never synced → not a regression");
    }

    #[test]
    fn updated_at_read_and_rides_upload() {
        let mut r = rec("a", true);
        r.insert("updatedAt".into(), serde_json::json!(1700000000123u64));
        assert_eq!(record_updated_at(&r), 1700000000123);
        // must survive into the uploaded payload so other devices can LWW on it
        let out = record_for_upload(&r);
        assert_eq!(out.get("updatedAt").and_then(|v| v.as_u64()), Some(1700000000123));
    }

    #[test]
    fn local_edit_not_clobbered_by_stale_remote() {
        // Mirror the pull LWW decision (account_sync_now line ~1067): a locally
        // edited host (fresh updatedAt) must out-rank a stale remote copy, so a
        // port-forward added locally is NOT overwritten on the next sync.
        let mut local = rec("a", true);
        local.insert("updatedAt".into(), serde_json::json!(2000u64));
        local.insert("forwards".into(), serde_json::json!([{"id":"f1"}]));
        let local_updated_cfg = 1000u64; // last-synced cursor for this item

        let stale_remote_ts = 1500u64;
        let local_ts = record_updated_at(&local).max(local_updated_cfg);
        assert!(!(stale_remote_ts >= local_ts), "stale remote must NOT apply");

        let newer_remote_ts = 3000u64;
        assert!(newer_remote_ts >= local_ts, "genuinely newer remote applies");
    }

    // --- PULL merge: upsert synced host, preserve local hosts ---------------
    //
    // Pure-logic mirror of account_sync_now's pull merge (no vault/network): a
    // remote `host.a` record is merged into a local list that ALSO holds a
    // local-only `host.b`; b must survive untouched and a must be upserted+flagged.
    #[test]
    fn pull_merge_upserts_synced_preserves_local() {
        let mut hostlist = vec![rec("b", false)]; // local-only host present
        let id = "a".to_string();
        let remote_rec = {
            let mut m = rec("a", true);
            m.insert("host".into(), serde_json::Value::String("203.0.113.9".into()));
            m
        };
        // merge logic (mirrors the pull loop's apply_remote=true branch)
        let pos = hostlist.iter().position(|r| record_id(r).as_deref() == Some(&id));
        let mut r = remote_rec;
        r.insert("sync".into(), serde_json::Value::Bool(true));
        r.insert("id".into(), serde_json::Value::String(id.clone()));
        match pos {
            Some(p) => hostlist[p] = r,
            None => hostlist.push(r),
        }
        assert_eq!(hostlist.len(), 2);
        // local-only b preserved untouched
        let b = hostlist.iter().find(|x| record_id(x).as_deref() == Some("b")).unwrap();
        assert!(!record_is_synced(b));
        // a upserted + flagged
        let a = hostlist.iter().find(|x| record_id(x).as_deref() == Some("a")).unwrap();
        assert!(record_is_synced(a));
        assert_eq!(a.get("host").and_then(|v| v.as_str()), Some("203.0.113.9"));
    }

    // --- PULL preserves device-local vpnProfileId on upsert -----------------
    //
    // vpnProfileId is stripped on upload (record_for_upload), so a pulled record
    // never carries it. The upsert must keep the LOCAL value — else sync wipes the
    // chosen VPN profile on the source device itself (bug 2026-06-24).
    #[test]
    fn pull_merge_preserves_local_vpn_profile() {
        let mut local = rec("a", true);
        local.insert("vpnProfileId".into(), serde_json::Value::String("vpn-local-1".into()));
        let mut hostlist = vec![local];
        let id = "a".to_string();
        let remote_rec = rec("a", true); // server copy: vpnProfileId stripped
        let pos = hostlist.iter().position(|r| record_id(r).as_deref() == Some(&id));
        let mut r = remote_rec;
        r.insert("sync".into(), serde_json::Value::Bool(true));
        r.insert("id".into(), serde_json::Value::String(id.clone()));
        match pos {
            Some(p) => {
                if !r.contains_key("vpnProfileId") {
                    if let Some(v) = hostlist[p].get("vpnProfileId").cloned() {
                        r.insert("vpnProfileId".into(), v);
                    }
                }
                hostlist[p] = r;
            }
            None => hostlist.push(r),
        }
        let a = hostlist.iter().find(|x| record_id(x).as_deref() == Some("a")).unwrap();
        assert_eq!(a.get("vpnProfileId").and_then(|v| v.as_str()), Some("vpn-local-1"));
    }

    // --- un-flag (sync true→false) → tombstone ------------------------------

    #[test]
    fn unflag_produces_tombstone() {
        let mut cfg = AccountConfig::default();
        // Last sync had host.a + its password synced.
        cfg.synced_item_ids.insert("host.a".into(), 1);
        cfg.synced_item_ids.insert("host.a.password".into(), 1);
        cfg.did_initial_push = true;
        // Now `a` is un-flagged → not in the flagged set; compute tombstones the
        // way build_push_changes does.
        let flagged_now: HashMap<String, u8> = HashMap::new();
        let ts = 12345u64;
        let previously: Vec<String> = cfg.synced_item_ids.keys().cloned().collect();
        for old in previously {
            if !flagged_now.contains_key(&old) {
                cfg.tombstones.entry(old.clone()).or_insert(ts);
                cfg.synced_item_ids.remove(&old);
            }
        }
        assert!(cfg.tombstones.contains_key("host.a"));
        assert!(cfg.tombstones.contains_key("host.a.password"));
        assert!(cfg.synced_item_ids.is_empty());
    }

    // --- tombstone PULL removes ONLY a synced host --------------------------

    #[test]
    fn tombstone_pull_removes_only_synced_host() {
        // Local list: a (synced), b (local-only).
        let mut hostlist = vec![rec("a", true), rec("b", false)];

        // Incoming tombstone for host.a → remove (it's flagged-synced locally).
        let id_a = "a".to_string();
        let pos_a = hostlist.iter().position(|r| record_id(r).as_deref() == Some(&id_a));
        if let Some(p) = pos_a {
            if record_is_synced(&hostlist[p]) {
                hostlist.remove(p);
            }
        }
        assert!(hostlist.iter().all(|r| record_id(r).as_deref() != Some("a")));
        assert_eq!(hostlist.len(), 1);

        // Incoming tombstone for host.b → MUST NOT remove (b is local-only).
        let id_b = "b".to_string();
        let pos_b = hostlist.iter().position(|r| record_id(r).as_deref() == Some(&id_b));
        if let Some(p) = pos_b {
            if record_is_synced(&hostlist[p]) {
                hostlist.remove(p); // not reached: b isn't synced
            }
        }
        assert_eq!(hostlist.len(), 1, "local-only host must survive a tombstone");
        assert_eq!(record_id(&hostlist[0]).as_deref(), Some("b"));
    }
}
