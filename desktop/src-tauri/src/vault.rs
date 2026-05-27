//! Bridge to a CLI-based secret manager.
//!
//! Phase 4 supports our `vault` CLI (age-encrypted key-value at
//! /matrix/secrets/vault.age) — `vault get <dotted.path>` returns the secret
//! on stdout. Easy to extend to `pass`, `bw get password`, 1Password CLI,
//! etc. later by making the binary configurable.
//!
//! NOTE: only works on machines where the binary is in PATH. On Windows there's
//! no `vault` by default — user gets a clear error.

use serde::Serialize;
use std::process::Command;

const VAULT_BIN: &str = "vault"; // configurable later

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault binary not found in PATH")]
    BinaryMissing,
    #[error("vault returned status {0}: {1}")]
    NonZero(i32, String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for VaultError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub async fn vault_get(key: String) -> Result<String, VaultError> {
    let out = tokio::task::spawn_blocking(move || {
        Command::new(VAULT_BIN).arg("get").arg(&key).output()
    })
    .await
    .map_err(|e| VaultError::Io(std::io::Error::other(e.to_string())))?;
    let out = match out {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(VaultError::BinaryMissing);
        }
        Err(e) => return Err(VaultError::Io(e)),
    };
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        return Err(VaultError::NonZero(
            code,
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub async fn vault_keys() -> Result<Vec<String>, VaultError> {
    let out = tokio::task::spawn_blocking(|| {
        Command::new(VAULT_BIN).arg("keys").output()
    })
    .await
    .map_err(|e| VaultError::Io(std::io::Error::other(e.to_string())))?;
    let out = match out {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(VaultError::BinaryMissing);
        }
        Err(e) => return Err(VaultError::Io(e)),
    };
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        return Err(VaultError::NonZero(
            code,
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}
