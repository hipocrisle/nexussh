//! Local filesystem browsing for the dual-pane SFTP file manager.
//!
//! Listing + a small set of write operations (mkdir / rename / delete) so the
//! LOCAL pane is a first-class file manager, not read-only. Copying *to* the
//! local disk reuses `sftp_download` (which writes the file), and copying *from*
//! it reuses `sftp_upload`. No new crates: home dir comes from the standard env
//! vars and the write ops use `std::fs`.

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

/// Available local drive roots. On Windows this probes `A:\`..`Z:\` and returns
/// the ones that exist (fixed disks, USB, mapped network drives, etc.) so the
/// local pane can offer a drive picker. On non-Windows there is a single root,
/// so we return just `["/"]` — the UI hides the picker when only one root is
/// reported, keeping Linux/mac clutter-free.
#[tauri::command]
pub fn fs_local_drives() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let mut out = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                out.push(root);
            }
        }
        // Fall back to C:\ if probing somehow found nothing, so the pane still
        // has a usable root.
        if out.is_empty() {
            out.push("C:\\".to_string());
        }
        out
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["/".to_string()]
    }
}

/// Size in bytes of a local file, or 0 if it doesn't exist / can't be read.
/// Used by the SFTP panel to detect a partially-downloaded target and offer to
/// resume it.
#[tauri::command]
pub fn fs_local_size(path: String) -> u64 {
    std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
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

/// Create a single new local directory. Mirrors `sftp_mkdir`: a single level
/// (NOT `create_dir_all`), so creating into a non-existent parent errors out
/// rather than silently materialising the whole chain.
#[tauri::command]
pub fn fs_local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| format!("{path}: {e}"))
}

/// Rename / move a local entry (file or directory). Mirrors `sftp_rename`.
#[tauri::command]
pub fn fs_local_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| format!("{from} → {to}: {e}"))
}

/// Delete a local entry: recursively for a directory, single-shot for a file.
/// Always invoked behind a UI confirm, mirroring `sftp_remove`.
#[tauri::command]
pub fn fs_local_delete(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let is_dir = std::fs::symlink_metadata(p)
        .map(|m| m.is_dir())
        .map_err(|e| format!("{path}: {e}"))?;
    let res = if is_dir {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
    res.map_err(|e| format!("{path}: {e}"))
}
