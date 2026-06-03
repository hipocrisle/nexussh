//! Native cross-platform vault — age-encrypted key-value secret store.
//!
//! Passphrase-protected (age scrypt): the master password is the only key,
//! never written to disk. Without it the vault file is undecryptable, so
//! host passwords are safe at rest even if the device is stolen.
//!
//! Plaintext payload format: `key.dotted.path = value\n` lines.
//! File lives in the app data dir as `vault.age` (created by `vault_create`).
//! Once unlocked, secrets + the passphrase live in RAM only (needed to
//! re-encrypt on writes); cleared on `vault_lock` or app quit.

use age::secrecy::SecretString;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_store::StoreExt;

const CONFIG_FILE: &str = "vault-config.json";
const CFG_VAULT_PATH: &str = "vault_path";

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("age encrypt: {0}")]
    Encrypt(String),
    #[error("age decrypt (wrong master password?): {0}")]
    Decrypt(String),
    #[error("vault payload is not UTF-8")]
    Utf8,
    #[error("vault not configured — create it first")]
    NotConfigured,
    #[error("vault already exists")]
    AlreadyExists,
    #[error("vault locked — call vault_unlock")]
    Locked,
    #[error("key not found: {0}")]
    KeyMissing(String),
    #[error("other: {0}")]
    Other(String),
}

impl Serialize for VaultError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// In-memory unlocked state. Holds the passphrase so writes can re-encrypt.
struct Unlocked {
    secrets: HashMap<String, String>,
    passphrase: String,
    vault_path: PathBuf,
}

#[derive(Default)]
pub struct VaultState {
    inner: Mutex<Option<Unlocked>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    pub configured: bool,
    pub unlocked: bool,
    pub vault_path: Option<String>,
}

// ---- crypto helpers ----

fn encrypt_payload(plaintext: &str, passphrase: &str) -> Result<Vec<u8>, VaultError> {
    let recipient = age::scrypt::Recipient::new(SecretString::from(passphrase.to_owned()));
    let encryptor = age::Encryptor::with_recipients(
        std::iter::once(&recipient as &dyn age::Recipient),
    )
    .map_err(|e| VaultError::Encrypt(e.to_string()))?;
    let mut out = vec![];
    let mut writer = encryptor
        .wrap_output(&mut out)
        .map_err(|e| VaultError::Encrypt(e.to_string()))?;
    writer
        .write_all(plaintext.as_bytes())
        .map_err(|e| VaultError::Encrypt(e.to_string()))?;
    writer
        .finish()
        .map_err(|e| VaultError::Encrypt(e.to_string()))?;
    Ok(out)
}

fn decrypt_payload(encrypted: &[u8], passphrase: &str) -> Result<String, VaultError> {
    let decryptor =
        age::Decryptor::new(encrypted).map_err(|e| VaultError::Decrypt(e.to_string()))?;
    let identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_owned()));
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| VaultError::Decrypt(e.to_string()))?;
    let mut out = vec![];
    reader.read_to_end(&mut out)?;
    String::from_utf8(out).map_err(|_| VaultError::Utf8)
}

/// Parse the decrypted payload. Current format is JSON (lossless for any
/// value — passwords with newlines, `=`, leading spaces, etc.). Falls back to
/// the legacy `key = value` line format so vaults written by older builds still
/// open; they get rewritten as JSON on the next `vault_set`/`vault_delete`.
fn parse_kv_text(text: &str) -> HashMap<String, String> {
    if let Ok(m) = serde_json::from_str::<HashMap<String, String>>(text) {
        return m;
    }
    // Legacy line format — note this was lossy for values with newlines; nothing
    // we can do to recover those, but plain passwords migrate fine.
    let mut m = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(eq_idx) = line.find('=') {
            let key = line[..eq_idx].trim().to_string();
            let val = line[eq_idx + 1..].trim().to_string();
            if !key.is_empty() {
                m.insert(key, val);
            }
        }
    }
    m
}

/// Serialize the secret map as JSON — handles arbitrary bytes in values
/// losslessly (unlike the old `k = v` lines, which silently truncated values
/// containing a newline and stripped leading/trailing whitespace).
fn serialize_kv(map: &HashMap<String, String>) -> String {
    serde_json::to_string(map).unwrap_or_else(|_| "{}".into())
}

/// Re-encrypt the in-memory map and write it to disk atomically: write to a
/// temp file in the same dir, then rename over the vault. A crash mid-write
/// leaves the old vault intact (rename is atomic on the same filesystem) — no
/// truncated/undecryptable file, and no stale plaintext-equivalent `.bak` that
/// retains deleted secrets a generation longer.
fn persist(u: &Unlocked) -> Result<(), VaultError> {
    let text = serialize_kv(&u.secrets);
    let encrypted = encrypt_payload(&text, &u.passphrase)?;
    if let Some(parent) = u.vault_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = u.vault_path.with_extension("age.tmp");
    std::fs::write(&tmp, &encrypted)?;
    std::fs::rename(&tmp, &u.vault_path)?;
    Ok(())
}

fn config_vault_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let store = app.store(CONFIG_FILE).ok()?;
    store
        .get(CFG_VAULT_PATH)
        .and_then(|v| v.as_str().map(PathBuf::from))
}

fn default_vault_path(app: &tauri::AppHandle) -> Result<PathBuf, VaultError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| VaultError::Other(e.to_string()))?;
    Ok(dir.join("vault.age"))
}

fn set_config_vault_path(app: &tauri::AppHandle, p: &PathBuf) -> Result<(), VaultError> {
    let store = app
        .store(CONFIG_FILE)
        .map_err(|e| VaultError::Other(e.to_string()))?;
    store.set(
        CFG_VAULT_PATH,
        serde_json::Value::String(p.display().to_string()),
    );
    store.save().map_err(|e| VaultError::Other(e.to_string()))?;
    Ok(())
}

// ---- commands ----

#[tauri::command]
pub async fn vault_status(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
) -> Result<VaultStatus, VaultError> {
    let vp = config_vault_path(&app);
    let configured = vp.as_ref().map(|p| p.exists()).unwrap_or(false);
    let unlocked = state.inner.lock().unwrap().is_some();
    Ok(VaultStatus {
        configured,
        unlocked,
        vault_path: vp.map(|p| p.display().to_string()),
    })
}

/// Create a brand-new empty vault encrypted with `master_password`, and
/// leave it unlocked. Errors if a vault file already exists.
#[tauri::command]
pub async fn vault_create(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    master_password: String,
) -> Result<(), VaultError> {
    if master_password.is_empty() {
        return Err(VaultError::Other("master password is empty".into()));
    }
    let path = match config_vault_path(&app) {
        Some(p) => p,
        None => default_vault_path(&app)?,
    };
    if path.exists() {
        return Err(VaultError::AlreadyExists);
    }
    let u = Unlocked {
        secrets: HashMap::new(),
        passphrase: master_password,
        vault_path: path.clone(),
    };
    persist(&u)?;
    set_config_vault_path(&app, &path)?;
    *state.inner.lock().unwrap() = Some(u);
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    master_password: String,
) -> Result<(), VaultError> {
    let path = config_vault_path(&app).ok_or(VaultError::NotConfigured)?;
    if !path.exists() {
        return Err(VaultError::NotConfigured);
    }
    let encrypted = std::fs::read(&path)?;
    let plaintext = decrypt_payload(&encrypted, &master_password)?;
    let map = parse_kv_text(&plaintext);
    *state.inner.lock().unwrap() = Some(Unlocked {
        secrets: map,
        passphrase: master_password,
        vault_path: path,
    });
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, VaultState>) -> Result<(), VaultError> {
    *state.inner.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn vault_get(
    state: State<'_, VaultState>,
    key: String,
) -> Result<String, VaultError> {
    let guard = state.inner.lock().unwrap();
    let u = guard.as_ref().ok_or(VaultError::Locked)?;
    u.secrets.get(&key).cloned().ok_or(VaultError::KeyMissing(key))
}

/// Store (or overwrite) a secret, then re-encrypt the vault to disk.
#[tauri::command]
pub async fn vault_set(
    state: State<'_, VaultState>,
    key: String,
    value: String,
) -> Result<(), VaultError> {
    let mut guard = state.inner.lock().unwrap();
    let u = guard.as_mut().ok_or(VaultError::Locked)?;
    u.secrets.insert(key, value);
    persist(u)?;
    Ok(())
}

/// Remove a secret, then re-encrypt the vault to disk.
#[tauri::command]
pub async fn vault_delete(
    state: State<'_, VaultState>,
    key: String,
) -> Result<(), VaultError> {
    let mut guard = state.inner.lock().unwrap();
    let u = guard.as_mut().ok_or(VaultError::Locked)?;
    u.secrets.remove(&key);
    persist(u)?;
    Ok(())
}

#[tauri::command]
pub async fn vault_keys(state: State<'_, VaultState>) -> Result<Vec<String>, VaultError> {
    let guard = state.inner.lock().unwrap();
    let u = guard.as_ref().ok_or(VaultError::Locked)?;
    let mut keys: Vec<String> = u.secrets.keys().cloned().collect();
    keys.sort();
    Ok(keys)
}

/// Internal helper for other modules (e.g. ssh.rs) to fetch a secret synchronously.
pub fn resolve(state: &VaultState, key: &str) -> Result<String, VaultError> {
    let guard = state.inner.lock().unwrap();
    let u = guard.as_ref().ok_or(VaultError::Locked)?;
    u.secrets
        .get(key)
        .cloned()
        .ok_or_else(|| VaultError::KeyMissing(key.to_string()))
}

/// Like `resolve` but returns None instead of erroring when the key is missing
/// or the vault is locked. Used by the TOFU handler for known_hosts-in-vault.
pub fn get_opt(state: &VaultState, key: &str) -> Option<String> {
    let guard = state.inner.lock().unwrap();
    guard.as_ref()?.secrets.get(key).cloned()
}

/// Insert/overwrite a value and persist. Errors if the vault is locked.
pub fn put(state: &VaultState, key: &str, value: String) -> Result<(), VaultError> {
    let mut guard = state.inner.lock().unwrap();
    let u = guard.as_mut().ok_or(VaultError::Locked)?;
    u.secrets.insert(key.to_string(), value);
    persist(u)
}

/// Change the master password of the unlocked vault: verify the old one, swap
/// in the new, and re-encrypt to disk. The vault must be unlocked.
#[tauri::command]
pub async fn vault_change_password(
    state: State<'_, VaultState>,
    old_password: String,
    new_password: String,
) -> Result<(), VaultError> {
    if new_password.is_empty() {
        return Err(VaultError::Other("new password is empty".into()));
    }
    let mut guard = state.inner.lock().unwrap();
    let u = guard.as_mut().ok_or(VaultError::Locked)?;
    if u.passphrase != old_password {
        return Err(VaultError::Decrypt("current password is wrong".into()));
    }
    u.passphrase = new_password;
    persist(u)?;
    Ok(())
}

/// Reset the vault: back up the (still-encrypted) vault file so a remembered
/// password can later recover it, then delete it and lock. After this the app
/// reports the vault as "not created" and the user can set a new one. Any
/// secrets — and the encrypted host list, if it lived here — are gone (that's
/// the point: it's the "forgot my master password" escape hatch). Returns the
/// backup file path, if one was made.
#[tauri::command]
pub async fn vault_reset(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
) -> Result<Option<String>, VaultError> {
    let backup = match config_vault_path(&app) {
        Some(path) if path.exists() => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let bak = path.with_extension(format!("age.backup-{ts}"));
            std::fs::copy(&path, &bak)?;
            std::fs::remove_file(&path)?;
            Some(bak.display().to_string())
        }
        _ => None,
    };
    *state.inner.lock().unwrap() = None;
    Ok(backup)
}
