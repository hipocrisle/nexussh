//! Session history — encrypted-at-rest recordings of terminal output.
//!
//! v1.1.0 removed the original feature because `.cast` files stored full session
//! output in PLAINTEXT (could include typed/echoed secrets). This brings it back
//! safely:
//!
//! - **Separate domain from the hosts vault.** History uses its OWN data key
//!   (`history-DEK`, an X25519 identity), DISTINCT from the vault's DEK. The
//!   history key is wrapped to the vault key (fast X25519) and stored in
//!   `history/key.age`; its public recipient sits in `history/dek.pub`. So a
//!   single master password unlocks both, the keys stay separate (independent
//!   rotation/wipe), and `vault.age` (hosts/passwords) is never touched or bloated.
//! - **Asymmetric append/read.** The public recipient (`dek.pub`, not secret) is
//!   readable any time, so the recorder can APPEND encrypted output even while the
//!   vault is LOCKED. The private identity only comes back at unlock (unwrap
//!   `key.age` with the vault key), so READING/replay requires the master password.
//! - **One file per session**, decrypted lazily — a large history never slows the
//!   vault unlock or hosts work; only the one recording you open is decrypted.
//!
//! File layout under `<app_data>/history/`:
//!   `dek.pub`        — history-DEK public recipient (`age1...`), plaintext.
//!   `key.age`        — history-DEK secret, age-encrypted to the VAULT recipient.
//!   `<id>.nxrec`     — recording: repeated `u32-LE len | age(gzip(events))` chunks.
//!   `<id>.meta`      — age(JSON SessionMeta), metadata for listing.
//!
//! This module (Phase 1) provides the crypto/key management, the on-disk format,
//! the list/read/delete/clear/stats commands, and store pruning. The live
//! recorder (tapping ssh output, alt-screen skipping, per-session ring) lands in
//! Phase 2 and builds on the primitives here.

use age::secrecy::ExposeSecret;
use age::x25519::{Identity, Recipient};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use tauri::{AppHandle, Manager, State};

use crate::vault::{self, VaultState};

// ---- store policy (Phase 4 will wire these to Settings) ----
/// Hard ceiling for the whole history store. Oldest recordings are pruned first.
const GLOBAL_CAP_BYTES: u64 = 250 * 1024 * 1024;
/// Recordings older than this are pruned regardless of total size.
const RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("vault locked — unlock to read history")]
    VaultLocked,
    #[error("history not initialised")]
    NotReady,
    #[error("invalid recording id")]
    BadId,
    #[error("other: {0}")]
    Other(String),
}

impl Serialize for HistoryError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Per-recording metadata (stored encrypted as `<id>.meta`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub host_id: String,
    /// Display label, e.g. `user@host` — sensitive, hence encrypted.
    pub label: String,
    /// Unix seconds.
    pub start: u64,
    pub end: Option<u64>,
    /// Uncompressed output bytes recorded.
    pub bytes: u64,
    /// Terminal size at start, for faithful replay (#258).
    pub cols: u16,
    pub rows: u16,
    /// "full" (records alt-screen/TUI) or "light" (skips it).
    pub mode: String,
    /// True if the per-session cap dropped earlier output.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryStats {
    pub sessions: u32,
    pub bytes: u64,
}

// ---- crypto + compression helpers ----

fn age_encrypt(plaintext: &[u8], recipient: &Recipient) -> Result<Vec<u8>, HistoryError> {
    let enc = age::Encryptor::with_recipients(std::iter::once(recipient as &dyn age::Recipient))
        .map_err(|e| HistoryError::Crypto(e.to_string()))?;
    let mut out = vec![];
    let mut w = enc
        .wrap_output(&mut out)
        .map_err(|e| HistoryError::Crypto(e.to_string()))?;
    w.write_all(plaintext)
        .map_err(|e| HistoryError::Crypto(e.to_string()))?;
    w.finish().map_err(|e| HistoryError::Crypto(e.to_string()))?;
    Ok(out)
}

fn age_decrypt(blob: &[u8], identity: &Identity) -> Result<Vec<u8>, HistoryError> {
    let dec = age::Decryptor::new(blob).map_err(|e| HistoryError::Crypto(e.to_string()))?;
    let mut r = dec
        .decrypt(std::iter::once(identity as &dyn age::Identity))
        .map_err(|e| HistoryError::Crypto(e.to_string()))?;
    let mut out = vec![];
    r.read_to_end(&mut out)?;
    Ok(out)
}

fn gzip(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data)?;
    e.finish()
}

fn gunzip(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut d = flate2::read::GzDecoder::new(data);
    let mut out = vec![];
    d.read_to_end(&mut out)?;
    Ok(out)
}

// ---- paths ----

fn history_dir(app: &AppHandle) -> Result<PathBuf, HistoryError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| HistoryError::Other(e.to_string()))?
        .join("history"))
}

fn rec_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.nxrec"))
}
fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.meta"))
}

/// Recording ids are app-generated (uuid-like). Reject anything that could
/// escape the history dir or hit an unexpected file.
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ---- key management ----

/// Create the history data key on first need. Requires the vault UNLOCKED (the
/// new key is wrapped to the vault's public recipient). Idempotent: a no-op once
/// `key.age` exists. Called from vault create + unlock so the key is ready (and
/// `dek.pub` exists for the locked-time recorder) right after the first unlock.
pub fn ensure_dek(app: &AppHandle, vault_state: &VaultState) -> Result<(), HistoryError> {
    let dir = history_dir(app)?;
    let key = dir.join("key.age");
    let pubf = dir.join("dek.pub");
    if key.exists() {
        // Key already minted; just make sure the public file is present (it may be
        // missing on a vault restored from backup). Deriving it needs unlock.
        if !pubf.exists() {
            if let Ok(id) = load_identity(app, vault_state) {
                let _ = std::fs::write(&pubf, id.to_public().to_string().as_bytes());
            }
        }
        return Ok(());
    }
    let vault_recipient_str =
        vault::dek_recipient_string(vault_state).ok_or(HistoryError::VaultLocked)?;
    let vault_recipient =
        Recipient::from_str(&vault_recipient_str).map_err(|e| HistoryError::Crypto(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    let hist = Identity::generate();
    let wrapped = age_encrypt(
        hist.to_string().expose_secret().as_bytes(),
        &vault_recipient,
    )?;
    // Write the public file first: if we crash between the two writes, a present
    // key.age with no dek.pub is self-healed above; the reverse would orphan a
    // pub with no key.
    std::fs::write(&pubf, hist.to_public().to_string().as_bytes())?;
    std::fs::write(&key, &wrapped)?;
    Ok(())
}

/// The history-DEK public recipient (`dek.pub`). Readable with NO vault — this is
/// what lets the recorder append while locked. (Phase 2 uses it.)
#[allow(dead_code)]
pub fn load_recipient(app: &AppHandle) -> Result<Recipient, HistoryError> {
    let p = history_dir(app)?.join("dek.pub");
    let s = std::fs::read_to_string(&p).map_err(|_| HistoryError::NotReady)?;
    Recipient::from_str(s.trim()).map_err(|e| HistoryError::Crypto(e.to_string()))
}

/// The history-DEK private identity — unwrap `key.age` with the vault key. Errors
/// if the vault is locked. Gates all reads/replay.
fn load_identity(app: &AppHandle, vault_state: &VaultState) -> Result<Identity, HistoryError> {
    let vault_id_str = vault::dek_secret(vault_state).map_err(|_| HistoryError::VaultLocked)?;
    let vault_id =
        Identity::from_str(vault_id_str.trim()).map_err(|e| HistoryError::Crypto(e.to_string()))?;
    let wrapped =
        std::fs::read(history_dir(app)?.join("key.age")).map_err(|_| HistoryError::NotReady)?;
    let secret = age_decrypt(&wrapped, &vault_id)?;
    let s = String::from_utf8(secret).map_err(|_| HistoryError::Crypto("hist key not utf8".into()))?;
    Identity::from_str(s.trim()).map_err(|e| HistoryError::Crypto(e.to_string()))
}

// ---- on-disk recording format ----

/// Append one chunk of recorded output: `u32-LE len | age(gzip(plaintext))`.
/// Returns the bytes written (for cap accounting). Recipient-only → works locked.
#[allow(dead_code)]
pub fn append_chunk(
    path: &Path,
    recipient: &Recipient,
    plaintext: &[u8],
) -> Result<u64, HistoryError> {
    let blob = age_encrypt(&gzip(plaintext)?, recipient)?;
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(&(blob.len() as u32).to_le_bytes())?;
    f.write_all(&blob)?;
    Ok(4 + blob.len() as u64)
}

/// Decrypt + decompress every chunk and concatenate back to the raw event bytes.
/// A truncated trailing chunk (crash mid-append) is tolerated — we stop there.
fn read_session(path: &Path, identity: &Identity) -> Result<Vec<u8>, HistoryError> {
    let bytes = std::fs::read(path)?;
    let mut out = vec![];
    let mut i = 0usize;
    while i + 4 <= bytes.len() {
        let n = u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        i += 4;
        let end = match i.checked_add(n) {
            Some(e) if e <= bytes.len() => e,
            _ => break, // truncated tail
        };
        let plain = gunzip(&age_decrypt(&bytes[i..end], identity)?)?;
        out.extend_from_slice(&plain);
        i = end;
    }
    Ok(out)
}

#[allow(dead_code)]
pub fn write_meta(
    dir: &Path,
    recipient: &Recipient,
    meta: &SessionMeta,
) -> Result<(), HistoryError> {
    let json = serde_json::to_vec(meta).map_err(|e| HistoryError::Other(e.to_string()))?;
    let blob = age_encrypt(&json, recipient)?;
    std::fs::create_dir_all(dir)?;
    let final_path = meta_path(dir, &meta.id);
    let tmp = dir.join(format!("{}.meta.tmp", meta.id));
    std::fs::write(&tmp, &blob)?;
    std::fs::rename(&tmp, &final_path)?;
    Ok(())
}

fn read_meta(path: &Path, identity: &Identity) -> Result<SessionMeta, HistoryError> {
    let blob = std::fs::read(path)?;
    let json = age_decrypt(&blob, identity)?;
    serde_json::from_slice(&json).map_err(|e| HistoryError::Other(e.to_string()))
}

// ---- commands ----

/// List recordings (metadata only), newest first. Requires the vault unlocked.
#[tauri::command]
pub async fn history_list(
    app: AppHandle,
    vault_state: State<'_, VaultState>,
) -> Result<Vec<SessionMeta>, HistoryError> {
    let identity = load_identity(&app, &vault_state)?;
    let dir = history_dir(&app)?;
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) == Some("meta") {
                // Skip a recording whose meta won't decrypt rather than failing
                // the whole list.
                if let Ok(m) = read_meta(&path, &identity) {
                    out.push(m);
                }
            }
        }
    }
    out.sort_by(|a, b| b.start.cmp(&a.start));
    Ok(out)
}

/// Decrypt one recording back to its raw event stream (asciinema-style NDJSON)
/// for headless-xterm replay. Requires the vault unlocked.
#[tauri::command]
pub async fn history_read(
    app: AppHandle,
    vault_state: State<'_, VaultState>,
    id: String,
) -> Result<String, HistoryError> {
    if !safe_id(&id) {
        return Err(HistoryError::BadId);
    }
    let identity = load_identity(&app, &vault_state)?;
    let bytes = read_session(&rec_path(&history_dir(&app)?, &id), &identity)?;
    String::from_utf8(bytes).map_err(|_| HistoryError::Crypto("events not utf8".into()))
}

/// Delete one recording (data + meta). No unlock needed.
#[tauri::command]
pub async fn history_delete(app: AppHandle, id: String) -> Result<(), HistoryError> {
    if !safe_id(&id) {
        return Err(HistoryError::BadId);
    }
    let dir = history_dir(&app)?;
    let _ = std::fs::remove_file(rec_path(&dir, &id));
    let _ = std::fs::remove_file(meta_path(&dir, &id));
    Ok(())
}

/// Delete ALL recordings (keeps the history key so future recording still works).
/// Returns how many recordings were removed.
#[tauri::command]
pub async fn history_clear(app: AppHandle) -> Result<u32, HistoryError> {
    let dir = history_dir(&app)?;
    let mut removed = 0u32;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            match path.extension().and_then(|x| x.to_str()) {
                Some("nxrec") => {
                    if std::fs::remove_file(&path).is_ok() {
                        removed += 1;
                    }
                }
                Some("meta") => {
                    let _ = std::fs::remove_file(&path);
                }
                _ => {}
            }
        }
    }
    Ok(removed)
}

/// Count + total size of recordings on disk. No unlock needed (file sizes only).
#[tauri::command]
pub async fn history_stats(app: AppHandle) -> Result<HistoryStats, HistoryError> {
    let dir = history_dir(&app)?;
    let mut sessions = 0u32;
    let mut bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) == Some("nxrec") {
                sessions += 1;
                if let Ok(m) = e.metadata() {
                    bytes += m.len();
                }
            }
        }
    }
    Ok(HistoryStats { sessions, bytes })
}

// ---- pruning (store-size safety) ----

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn delete_pair(dir: &Path, id: &str) {
    let _ = std::fs::remove_file(rec_path(dir, id));
    let _ = std::fs::remove_file(meta_path(dir, id));
}

/// Enforce store limits using ONLY file mtime/size (no vault needed, runs at
/// startup): drop recordings past the retention window, then drop oldest until
/// the total is under the global cap. Per-host count limits (need decrypted
/// metas) are a later refinement.
pub fn prune(app: &AppHandle) -> Result<(), HistoryError> {
    let dir = history_dir(app)?;
    if !dir.exists() {
        return Ok(());
    }
    // (id, size, mtime) for every recording.
    let mut recs: Vec<(String, u64, u64)> = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("nxrec") {
                continue;
            }
            let id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            recs.push((id, md.len(), mtime_secs(&md)));
        }
    }
    let now = now_secs();
    // 1. Retention by age.
    recs.retain(|(id, _, mtime)| {
        if now.saturating_sub(*mtime) > RETENTION_SECS {
            delete_pair(&dir, id);
            false
        } else {
            true
        }
    });
    // 2. Global cap: drop oldest first until under the ceiling.
    let mut total: u64 = recs.iter().map(|(_, sz, _)| *sz).sum();
    if total > GLOBAL_CAP_BYTES {
        recs.sort_by(|a, b| a.2.cmp(&b.2)); // oldest mtime first
        for (id, sz, _) in &recs {
            if total <= GLOBAL_CAP_BYTES {
                break;
            }
            delete_pair(&dir, id);
            total = total.saturating_sub(*sz);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nxhist_{}_{}", std::process::id(), name))
    }

    // Append several chunks, then read them back: the concatenation must equal
    // the original event bytes, and only the matching identity can read them.
    #[test]
    fn chunk_round_trip() {
        let id = Identity::generate();
        let rec = id.to_public();
        let path = tmp("rt.nxrec");
        let _ = std::fs::remove_file(&path);

        let a = b"[0.1,\"o\",\"hello \"]\n";
        let b = b"[0.2,\"o\",\"world\"]\n";
        append_chunk(&path, &rec, a).unwrap();
        append_chunk(&path, &rec, b).unwrap();

        let got = read_session(&path, &id).unwrap();
        let mut expect = Vec::new();
        expect.extend_from_slice(a);
        expect.extend_from_slice(b);
        assert_eq!(got, expect);

        // A different identity must NOT decrypt.
        let other = Identity::generate();
        assert!(read_session(&path, &other).is_err());
        let _ = std::fs::remove_file(&path);
    }

    // A torn final chunk (simulated crash mid-append) is tolerated: earlier
    // complete chunks still read back.
    #[test]
    fn tolerates_truncated_tail() {
        let id = Identity::generate();
        let rec = id.to_public();
        let path = tmp("torn.nxrec");
        let _ = std::fs::remove_file(&path);

        append_chunk(&path, &rec, b"[0.1,\"o\",\"ok\"]\n").unwrap();
        // Append a bogus length header with no body — the reader should stop.
        {
            let mut f = OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(&999u32.to_le_bytes()).unwrap();
            f.write_all(b"short").unwrap();
        }
        let got = read_session(&path, &id).unwrap();
        assert_eq!(got, b"[0.1,\"o\",\"ok\"]\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn meta_round_trip() {
        let id = Identity::generate();
        let rec = id.to_public();
        let dir = tmp("metadir");
        let _ = std::fs::remove_dir_all(&dir);
        let m = SessionMeta {
            id: "abc-123".into(),
            host_id: "h1".into(),
            label: "root@example.com".into(),
            start: 1000,
            end: Some(1050),
            bytes: 42,
            cols: 120,
            rows: 30,
            mode: "light".into(),
            truncated: false,
        };
        write_meta(&dir, &rec, &m).unwrap();
        let got = read_meta(&meta_path(&dir, "abc-123"), &id).unwrap();
        assert_eq!(got.label, "root@example.com");
        assert_eq!(got.end, Some(1050));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_id_rejects_traversal() {
        assert!(safe_id("a1B2-c3_d4"));
        assert!(!safe_id("../etc/passwd"));
        assert!(!safe_id("a/b"));
        assert!(!safe_id(""));
    }
}
