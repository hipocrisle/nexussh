//! Server-side crypto helpers.
//!
//! IMPORTANT: the server never sees the user's master password, derived
//! encryption keys, or any item plaintext. The CLIENT performs the real crypto:
//!
//!   masterKey  = Argon2id(password, account_salt)        // never leaves device
//!   auth_hash  = HKDF(masterKey, "nexussh-auth")          // sent to server at login
//!   encKey     = HKDF(masterKey, ...)                     // never leaves device
//!
//! `auth_hash` is itself a KDF output, but we still treat it like a password and
//! store only `server_hash = Argon2id(auth_hash, random per-user server salt)`.
//! That way a DB leak does not hand an attacker the value they could replay as
//! `auth_hash`. Verification uses argon2's constant-time PHC verify.

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use argon2::password_hash::rand_core::RngCore;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Argon2id parameters used to wrap the client-supplied `auth_hash`.
/// These guard against offline brute force of a leaked verifier DB. `auth_hash`
/// already carries the client's expensive Argon2id work, so we keep server cost
/// moderate to avoid a trivial login DoS.
fn argon2() -> Argon2<'static> {
    Argon2::default() // Argon2id, v19, m=19456 KiB, t=2, p=1 (OWASP baseline)
}

/// Hash a client `auth_hash` with a fresh random salt → PHC string for storage.
pub fn hash_auth(auth_hash: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let phc = argon2().hash_password(auth_hash.as_bytes(), &salt)?.to_string();
    Ok(phc)
}

/// Constant-time verify of a client `auth_hash` against the stored PHC string.
pub fn verify_auth(auth_hash: &str, stored_phc: &str) -> bool {
    match PasswordHash::new(stored_phc) {
        Ok(parsed) => argon2()
            .verify_password(auth_hash.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Generate a random URL-safe-ish token of `n` bytes, base64 (standard) encoded.
pub fn random_token(n: usize) -> String {
    let mut buf = vec![0u8; n];
    OsRng.fill_bytes(&mut buf);
    B64.encode(buf)
}

/// A UUIDv4 string, used for user_id / device_id.
pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Generate a human-friendly one-time recovery code, e.g. "a1b2-c3d4-e5f6".
pub fn random_recovery_code() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous chars
    let mut rng_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut rng_bytes);
    let chars: Vec<char> = rng_bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect();
    format!(
        "{}{}{}{}-{}{}{}{}-{}{}{}{}",
        chars[0], chars[1], chars[2], chars[3], chars[4], chars[5], chars[6], chars[7], chars[8],
        chars[9], chars[10], chars[11]
    )
}

/// Hash a recovery code for storage (SHA-256, hex). Codes are high-entropy
/// random so a fast hash is acceptable; we never store them in the clear.
pub fn hash_recovery_code(code: &str) -> String {
    let mut h = Sha256::new();
    h.update(code.trim().as_bytes());
    hex::encode(h.finalize())
}

/// Constant-time compare two recovery-code hashes (hex strings of equal length).
pub fn recovery_hash_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    ab.ct_eq(bb).into()
}
