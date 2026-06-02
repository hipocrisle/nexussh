//! One-shot legacy cleanup run on every startup.
//!
//! v1.1.0 removed the session-recording feature, but older versions left
//! `.cast` / `.log` / `.json` recordings of full SSH session output (which
//! could include typed secrets) in `<app_data>/sessions/`. Delete that
//! whole directory so nothing sensitive lingers on disk. No-op once it's
//! gone.

use tauri::Manager;

#[tauri::command]
pub async fn purge_legacy_sessions(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sessions");
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0u32;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    // Remove the now-empty directory too (ignore failure).
    let _ = std::fs::remove_dir(&dir);
    Ok(removed)
}
