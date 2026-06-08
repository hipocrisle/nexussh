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

use age::secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::str::FromStr;
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

/// In-memory unlocked state. Envelope encryption: the slow scrypt KDF runs only
/// to wrap/unwrap a random data key (`dek`); every write re-encrypts the content
/// with that data key via fast X25519, NOT scrypt. So saving a host is now a few
/// ms instead of ~1s. `wrapped_dek` is the cached scrypt-wrapped data key (it's
/// rebuilt only on create / password-change), written verbatim into every file.
struct Unlocked {
    secrets: HashMap<String, String>,
    passphrase: String,
    vault_path: PathBuf,
    dek: age::x25519::Identity,
    dek_recipient: age::x25519::Recipient,
    wrapped_dek: Vec<u8>,
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

// ---- envelope encryption ----
// File layout for the new format:
//   b"NXV1" | u32-LE len(wrapped_dek) | wrapped_dek | content
// `wrapped_dek` is the data key, scrypt-wrapped with the master password (slow,
// built once per unlock/create/password-change). `content` is the kv-JSON
// encrypted to the data key's X25519 recipient (fast, every write). Legacy
// vaults (a bare age-scrypt blob, no magic) still decrypt and migrate on the
// next write.

const ENVELOPE_MAGIC: &[u8; 4] = b"NXV1";

fn build_envelope(wrapped_dek: &[u8], content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + wrapped_dek.len() + content.len());
    out.extend_from_slice(ENVELOPE_MAGIC);
    out.extend_from_slice(&(wrapped_dek.len() as u32).to_le_bytes());
    out.extend_from_slice(wrapped_dek);
    out.extend_from_slice(content);
    out
}

/// Split an NXV1 file into (wrapped_dek, content). Returns None for the legacy
/// (bare age-scrypt) format.
fn parse_envelope(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    if bytes.len() < 8 || &bytes[0..4] != ENVELOPE_MAGIC {
        return None;
    }
    let n = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    let end = 8usize.checked_add(n)?;
    if bytes.len() < end {
        return None;
    }
    Some((&bytes[8..end], &bytes[end..]))
}

fn encrypt_to_recipient(
    plaintext: &str,
    recipient: &age::x25519::Recipient,
) -> Result<Vec<u8>, VaultError> {
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(recipient as &dyn age::Recipient))
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

fn decrypt_with_identity(
    encrypted: &[u8],
    identity: &age::x25519::Identity,
) -> Result<String, VaultError> {
    let decryptor =
        age::Decryptor::new(encrypted).map_err(|e| VaultError::Decrypt(e.to_string()))?;
    let mut reader = decryptor
        .decrypt(std::iter::once(identity as &dyn age::Identity))
        .map_err(|e| VaultError::Decrypt(e.to_string()))?;
    let mut out = vec![];
    reader.read_to_end(&mut out)?;
    String::from_utf8(out).map_err(|_| VaultError::Utf8)
}

/// Generate a fresh random data key and scrypt-wrap it with `passphrase`. The
/// scrypt cost is paid HERE (once per unlock/create/password-change), not on
/// every write. Returns the identity, its public recipient, and the wrapped
/// blob to embed in the file.
fn new_data_key(
    passphrase: &str,
) -> Result<(age::x25519::Identity, age::x25519::Recipient, Vec<u8>), VaultError> {
    let dek = age::x25519::Identity::generate();
    let recipient = dek.to_public();
    let secret = dek.to_string();
    let wrapped = encrypt_payload(secret.expose_secret(), passphrase)?;
    Ok((dek, recipient, wrapped))
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
    // Fast path: encrypt the content to the cached data key (no scrypt), then
    // prepend the already-wrapped data key. scrypt is NOT touched here.
    let content = encrypt_to_recipient(&text, &u.dek_recipient)?;
    let encrypted = build_envelope(&u.wrapped_dek, &content);
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
    let (dek, dek_recipient, wrapped_dek) = new_data_key(&master_password)?;
    let u = Unlocked {
        secrets: HashMap::new(),
        passphrase: master_password,
        vault_path: path.clone(),
        dek,
        dek_recipient,
        wrapped_dek,
    };
    persist(&u)?;
    set_config_vault_path(&app, &path)?;
    *state.inner.lock().unwrap() = Some(u);
    // Mint the separate history data key now that the vault key exists (the
    // history key is wrapped to it). Best-effort — vault creation must succeed
    // even if history init can't (e.g. read-only history dir).
    let _ = crate::history::ensure_dek(&app, &state);
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
    let (map, dek, dek_recipient, wrapped_dek) = match parse_envelope(&encrypted) {
        // New format: scrypt-unwrap the data key once, then content is fast.
        Some((wrapped, content)) => {
            let dek_str = decrypt_payload(wrapped, &master_password)?;
            let dek = age::x25519::Identity::from_str(dek_str.trim())
                .map_err(|e| VaultError::Decrypt(e.to_string()))?;
            let recipient = dek.to_public();
            let plaintext = decrypt_with_identity(content, &dek)?;
            (parse_kv_text(&plaintext), dek, recipient, wrapped.to_vec())
        }
        // Legacy bare age-scrypt vault: decrypt with the passphrase, then mint a
        // data key so the NEXT write upgrades the file to the envelope format.
        None => {
            let plaintext = decrypt_payload(&encrypted, &master_password)?;
            let map = parse_kv_text(&plaintext);
            let (dek, recipient, wrapped) = new_data_key(&master_password)?;
            (map, dek, recipient, wrapped)
        }
    };
    *state.inner.lock().unwrap() = Some(Unlocked {
        secrets: map,
        passphrase: master_password,
        vault_path: path,
        dek,
        dek_recipient,
        wrapped_dek,
    });
    // Ensure the history data key exists / its public file is present now that
    // we're unlocked (covers vaults created before the history feature).
    let _ = crate::history::ensure_dek(&app, &state);
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

/// Export the unlocked vault's data key as its age secret string. Used ONLY by
/// the biometric enroll flow to hand the key to the Android Keystore for
/// hardware-backed, fingerprint-gated wrapping. Errors if locked.
pub fn dek_secret(state: &VaultState) -> Result<String, VaultError> {
    let guard = state.inner.lock().unwrap();
    let u = guard.as_ref().ok_or(VaultError::Locked)?;
    Ok(u.dek.to_string().expose_secret().to_owned())
}

/// The unlocked vault data key's PUBLIC recipient (`age1...`). Used by the
/// history module to wrap its own separate data key to the vault key. Returns
/// None when locked. Public is not secret, but it's only meaningful while
/// unlocked (the matching identity is what gates reads).
pub fn dek_recipient_string(state: &VaultState) -> Option<String> {
    let guard = state.inner.lock().unwrap();
    guard.as_ref().map(|u| u.dek_recipient.to_string())
}

/// Unlock the vault from a data key directly (no master password, no scrypt) —
/// the biometric path: the keystore released the DEK after a fingerprint, and
/// we decrypt the content with it. `passphrase` is left empty, so a password
/// change still requires a password-based unlock.
pub fn unlock_with_dek(
    app: &tauri::AppHandle,
    state: &VaultState,
    dek_str: &str,
) -> Result<(), VaultError> {
    let path = config_vault_path(app).ok_or(VaultError::NotConfigured)?;
    let bytes = std::fs::read(&path)?;
    let (wrapped, content) = parse_envelope(&bytes)
        .ok_or_else(|| VaultError::Decrypt("vault is not in envelope format".into()))?;
    let dek = age::x25519::Identity::from_str(dek_str.trim())
        .map_err(|e| VaultError::Decrypt(e.to_string()))?;
    let dek_recipient = dek.to_public();
    let plaintext = decrypt_with_identity(content, &dek)?;
    let map = parse_kv_text(&plaintext);
    *state.inner.lock().unwrap() = Some(Unlocked {
        secrets: map,
        passphrase: String::new(),
        vault_path: path,
        dek,
        dek_recipient,
        wrapped_dek: wrapped.to_vec(),
    });
    let _ = crate::history::ensure_dek(app, state);
    Ok(())
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
    // Re-wrap the SAME data key under the new password (the only scrypt pass);
    // the content key is unchanged, so secrets don't need re-encrypting.
    let rewrapped = encrypt_payload(u.dek.to_string().expose_secret(), &new_password)?;
    u.passphrase = new_password;
    u.wrapped_dek = rewrapped;
    persist(u)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultBackup {
    /// Absolute path to the backup file.
    pub path: String,
    /// Unix seconds parsed from the `vault.age.backup-<ts>` name (0 if unknown).
    pub created: u64,
}

/// List vault backups (`vault.age.backup-*`) sitting next to the vault file,
/// newest first, so the user can restore one after a reset.
#[tauri::command]
pub async fn vault_list_backups(app: tauri::AppHandle) -> Result<Vec<VaultBackup>, VaultError> {
    let base = match config_vault_path(&app) {
        Some(p) => p,
        None => default_vault_path(&app)?,
    };
    let dir = match base.parent() {
        Some(d) => d.to_path_buf(),
        None => return Ok(vec![]),
    };
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(ts) = name.strip_prefix("vault.age.backup-") {
                out.push(VaultBackup {
                    path: entry.path().display().to_string(),
                    created: ts.parse().unwrap_or(0),
                });
            }
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created)); // newest first
    Ok(out)
}

/// Restore a chosen backup: copy it over the vault path and lock. The user then
/// unlocks it with the master password it was created under. Only files that
/// look like our own backups (in the vault dir, `vault.age.backup-` prefix) are
/// accepted, so this can't be turned into an arbitrary file copy.
#[tauri::command]
pub async fn vault_restore_backup(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    path: String,
) -> Result<(), VaultError> {
    let src = std::path::PathBuf::from(&path);
    let target = match config_vault_path(&app) {
        Some(p) => p,
        None => default_vault_path(&app)?,
    };
    let dir = target.parent().map(|d| d.to_path_buf());
    let valid = src
        .file_name()
        .map(|n| n.to_string_lossy().starts_with("vault.age.backup-"))
        .unwrap_or(false)
        && src.parent().map(|p| p.to_path_buf()) == dir
        && src.exists();
    if !valid {
        return Err(VaultError::Other("not a vault backup".into()));
    }
    if let Some(d) = &dir {
        std::fs::create_dir_all(d)?;
    }
    std::fs::copy(&src, &target)?;
    set_config_vault_path(&app, &target)?;
    *state.inner.lock().unwrap() = None; // locked — unlock with the old password
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

#[cfg(test)]
mod tests {
    use super::*;

    // Full envelope round-trip: wrap a data key with scrypt, encrypt content to
    // it, reassemble the file, then parse + decrypt back to the original.
    #[test]
    fn envelope_round_trip() {
        let pass = "correct horse battery staple";
        let (dek, recipient, wrapped) = new_data_key(pass).unwrap();
        let content = encrypt_to_recipient("{\"host.x.password\":\"hunter2\"}", &recipient).unwrap();
        let file = build_envelope(&wrapped, &content);

        let (w2, c2) = parse_envelope(&file).expect("should parse as NXV1");
        assert_eq!(w2, wrapped.as_slice());
        // Unwrap the data key via the password, then decrypt the content.
        let dek_str = decrypt_payload(w2, pass).unwrap();
        let dek2 = age::x25519::Identity::from_str(dek_str.trim()).unwrap();
        assert_eq!(dek2.to_public().to_string(), recipient.to_string());
        let got = decrypt_with_identity(c2, &dek).unwrap();
        assert_eq!(got, "{\"host.x.password\":\"hunter2\"}");
    }

    // A wrong master password can't unwrap the data key.
    #[test]
    fn envelope_wrong_password_fails() {
        let (_dek, recipient, wrapped) = new_data_key("right").unwrap();
        let _ = encrypt_to_recipient("{}", &recipient).unwrap();
        assert!(decrypt_payload(&wrapped, "wrong").is_err());
    }

    // Legacy bare age-scrypt vaults have no NXV1 magic, so they take the
    // migration path (parse_envelope → None) and still decrypt by password.
    #[test]
    fn legacy_blob_is_not_envelope_but_decrypts() {
        let pass = "legacy-pass";
        let blob = encrypt_payload("{\"a\":\"b\"}", pass).unwrap();
        assert!(parse_envelope(&blob).is_none());
        let text = decrypt_payload(&blob, pass).unwrap();
        assert_eq!(parse_kv_text(&text).get("a").map(String::as_str), Some("b"));
    }

    #[test]
    fn parse_envelope_rejects_garbage() {
        assert!(parse_envelope(b"").is_none());
        assert!(parse_envelope(b"NXV1").is_none()); // no length/body
        // magic + length claiming more than is present
        let mut bad = Vec::from(*ENVELOPE_MAGIC);
        bad.extend_from_slice(&999u32.to_le_bytes());
        bad.extend_from_slice(b"short");
        assert!(parse_envelope(&bad).is_none());
    }
}
