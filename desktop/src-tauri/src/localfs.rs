//! Local filesystem browsing for the dual-pane SFTP file manager.
//!
//! Read-only listing only — copying *to* the local disk reuses `sftp_download`
//! (which writes the file), and copying *from* it reuses `sftp_upload`. No new
//! crates: home dir comes from the standard env vars.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct LocalEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// The user's home directory (`$HOME`, or `%USERPROFILE%` on Windows). Falls
/// back to "/" so the local pane always has a starting point.
#[tauri::command]
pub fn fs_local_home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string())
}

/// List a local directory: dirs first, then case-insensitive by name (mirrors
/// `sftp_list`). Entries whose metadata can't be read are skipped rather than
/// aborting the whole listing. Returns a clear error string on failure.
#[tauri::command]
pub fn fs_local_list(path: String) -> Result<Vec<LocalEntry>, String> {
    let dir = Path::new(&path);
    let read = std::fs::read_dir(dir).map_err(|e| format!("{path}: {e}"))?;

    let mut out: Vec<LocalEntry> = Vec::new();
    for entry in read.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // unreadable entry — skip, don't abort
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(LocalEntry {
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }

    // Dirs first, then alphabetical (case-insensitive) — same as sftp_list.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}
