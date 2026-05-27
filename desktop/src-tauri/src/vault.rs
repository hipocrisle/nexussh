//! Native cross-platform vault — age-encrypted key-value file.
//!
//! Supports the same file format as our server-side `/matrix/secrets/vault.age`:
//! age v1 encrypted payload, plaintext is `key.dotted.path = value\n` lines.
//!
//! Unlock with an X25519 identity (private key file from `age-keygen`).
//! Once unlocked, secrets live in RAM only; locked when app quits or via
//! explicit `vault_lock` command. No external CLI dependency — works on
//! Windows / macOS / Linux / Android wherever Tauri runs.

use age::{Decryptor, Identity, x25519};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_store::StoreExt;

const CONFIG_FILE: &str = "vault-config.json";
const CFG_VAULT_PATH: &str = "vault_path";
const CFG_KEY_PATH: &str = "key_path";

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("age key parse: {0}")]
    KeyParse(String),
    #[error("age decrypt: {0}")]
    Decrypt(String),
    #[error("vault payload is not UTF-8")]
    Utf8,
    #[error("vault not configured — set vault & key paths first")]
    NotConfigured,
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

#[derive(Default)]
pub struct VaultState {
    /// None when locked; Some(map) when unlocked.
    secrets: Mutex<Option<HashMap<String, String>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    pub configured: bool,
    pub unlocked: bool,
    pub vault_path: Option<String>,
    pub key_path: Option<String>,
}

fn read_age_identity(key_path: &PathBuf) -> Result<x25519::Identity, VaultError> {
    let text = std::fs::read_to_string(key_path)?;
    // Strip comment lines (starting with #) and blank lines; take the first
    // AGE-SECRET-KEY-... line.
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("AGE-SECRET-KEY-") {
            return x25519::Identity::from_str(line)
                .map_err(|e| VaultError::KeyParse(e.to_string()));
        }
    }
    Err(VaultError::KeyParse(
        "no AGE-SECRET-KEY- line found in key file".into(),
    ))
}

fn decrypt_with(
    vault_path: &PathBuf,
    identity: &x25519::Identity,
) -> Result<String, VaultError> {
    let encrypted = std::fs::read(vault_path)?;
    let decryptor =
        Decryptor::new(&encrypted[..]).map_err(|e| VaultError::Decrypt(e.to_string()))?;
    let mut out = vec![];
    let mut reader = decryptor
        .decrypt(std::iter::once(identity as &dyn Identity))
        .map_err(|e| VaultError::Decrypt(e.to_string()))?;
    reader.read_to_end(&mut out)?;
    String::from_utf8(out).map_err(|_| VaultError::Utf8)
}

/// Plaintext line format: `key.dotted.path = value`
fn parse_kv_text(text: &str) -> HashMap<String, String> {
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

fn config_paths(app: &tauri::AppHandle) -> Result<(Option<PathBuf>, Option<PathBuf>), VaultError> {
    let store = app
        .store(CONFIG_FILE)
        .map_err(|e| VaultError::Other(e.to_string()))?;
    let vault = store
        .get(CFG_VAULT_PATH)
        .and_then(|v| v.as_str().map(PathBuf::from));
    let key = store
        .get(CFG_KEY_PATH)
        .and_then(|v| v.as_str().map(PathBuf::from));
    Ok((vault, key))
}

#[tauri::command]
pub async fn vault_set_paths(
    app: tauri::AppHandle,
    vault_path: String,
    key_path: String,
) -> Result<(), VaultError> {
    let store = app
        .store(CONFIG_FILE)
        .map_err(|e| VaultError::Other(e.to_string()))?;
    store.set(CFG_VAULT_PATH, serde_json::Value::String(vault_path));
    store.set(CFG_KEY_PATH, serde_json::Value::String(key_path));
    store
        .save()
        .map_err(|e| VaultError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn vault_status(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
) -> Result<VaultStatus, VaultError> {
    let (vp, kp) = config_paths(&app)?;
    let unlocked = state.secrets.lock().unwrap().is_some();
    Ok(VaultStatus {
        configured: vp.is_some() && kp.is_some(),
        unlocked,
        vault_path: vp.map(|p| p.display().to_string()),
        key_path: kp.map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub async fn vault_unlock(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    let (vp, kp) = config_paths(&app)?;
    let vault_path = vp.ok_or(VaultError::NotConfigured)?;
    let key_path = kp.ok_or(VaultError::NotConfigured)?;
    let identity = read_age_identity(&key_path)?;
    let plaintext = decrypt_with(&vault_path, &identity)?;
    let map = parse_kv_text(&plaintext);
    *state.secrets.lock().unwrap() = Some(map);
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, VaultState>) -> Result<(), VaultError> {
    *state.secrets.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn vault_get(
    state: State<'_, VaultState>,
    key: String,
) -> Result<String, VaultError> {
    let guard = state.secrets.lock().unwrap();
    let map = guard.as_ref().ok_or(VaultError::Locked)?;
    map.get(&key)
        .cloned()
        .ok_or(VaultError::KeyMissing(key))
}

/// Internal helper for other modules (e.g. ssh.rs) to fetch a secret synchronously.
pub fn resolve(state: &VaultState, key: &str) -> Result<String, VaultError> {
    let guard = state.secrets.lock().unwrap();
    let map = guard.as_ref().ok_or(VaultError::Locked)?;
    map.get(key).cloned().ok_or_else(|| VaultError::KeyMissing(key.to_string()))
}

#[tauri::command]
pub async fn vault_keys(state: State<'_, VaultState>) -> Result<Vec<String>, VaultError> {
    let guard = state.secrets.lock().unwrap();
    let map = guard.as_ref().ok_or(VaultError::Locked)?;
    let mut keys: Vec<String> = map.keys().cloned().collect();
    keys.sort();
    Ok(keys)
}
