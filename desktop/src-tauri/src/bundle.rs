//! Shareable host bundle — an age-passphrase-encrypted file holding a subset
//! of the host tree (and optionally VPN settings) for transfer to a phone or
//! a colleague. Passwords are never included by the frontend; the shared
//! passphrase is the only key.
//!
//! The plaintext payload is an opaque JSON string built/consumed entirely on
//! the frontend — this module only does the crypto + file I/O.

use age::secrecy::SecretString;
use serde::Serialize;
use std::io::{Read, Write};

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("age encrypt: {0}")]
    Encrypt(String),
    #[error("age decrypt (wrong password?): {0}")]
    Decrypt(String),
    #[error("bundle payload is not UTF-8")]
    Utf8,
    #[error("password is empty")]
    EmptyPassword,
}

impl Serialize for BundleError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn encrypt(plaintext: &str, passphrase: &str) -> Result<Vec<u8>, BundleError> {
    let recipient = age::scrypt::Recipient::new(SecretString::from(passphrase.to_owned()));
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|e| BundleError::Encrypt(e.to_string()))?;
    let mut out = vec![];
    let mut writer = encryptor
        .wrap_output(&mut out)
        .map_err(|e| BundleError::Encrypt(e.to_string()))?;
    writer
        .write_all(plaintext.as_bytes())
        .map_err(|e| BundleError::Encrypt(e.to_string()))?;
    writer
        .finish()
        .map_err(|e| BundleError::Encrypt(e.to_string()))?;
    Ok(out)
}

fn decrypt(encrypted: &[u8], passphrase: &str) -> Result<String, BundleError> {
    let decryptor =
        age::Decryptor::new(encrypted).map_err(|e| BundleError::Decrypt(e.to_string()))?;
    let identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_owned()));
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| BundleError::Decrypt(e.to_string()))?;
    let mut out = vec![];
    reader.read_to_end(&mut out)?;
    String::from_utf8(out).map_err(|_| BundleError::Utf8)
}

/// Encrypt `content` with `passphrase` and write the age file to `path`.
#[tauri::command]
pub async fn bundle_export(
    path: String,
    passphrase: String,
    content: String,
) -> Result<(), BundleError> {
    if passphrase.is_empty() {
        return Err(BundleError::EmptyPassword);
    }
    let encrypted = encrypt(&content, &passphrase)?;
    std::fs::write(&path, &encrypted)?;
    Ok(())
}

/// Read + decrypt the age bundle at `path` and return the plaintext JSON.
#[tauri::command]
pub async fn bundle_import(path: String, passphrase: String) -> Result<String, BundleError> {
    if passphrase.is_empty() {
        return Err(BundleError::EmptyPassword);
    }
    let encrypted = std::fs::read(&path)?;
    decrypt(&encrypted, &passphrase)
}
