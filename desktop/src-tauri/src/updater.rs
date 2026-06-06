//! Auto-update — лёгкая обёртка над tauri-plugin-updater.
//!
//! Эндпоинт + публичный ключ заданы в `tauri.conf.json`. Frontend дёргает
//! `check_for_update`, получает Option<UpdateInfo>; если Some — может вызвать
//! `install_update`, который скачает, верифицирует подпись и перезапустит app.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("updater: {0}")]
    Plugin(String),
}

impl serde::Serialize for UpdateError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, UpdateError> {
    let updater = app
        .updater()
        .map_err(|e| UpdateError::Plugin(e.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|e| UpdateError::Plugin(e.to_string()))?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        date: u.date.map(|d| d.to_string()),
        body: u.body.clone(),
    }))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), UpdateError> {
    let updater = app
        .updater()
        .map_err(|e| UpdateError::Plugin(e.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|e| UpdateError::Plugin(e.to_string()))?;
    let Some(update) = update else {
        return Err(UpdateError::Plugin("no update available".into()));
    };

    // Surface download/install progress to the frontend on the same
    // `update-progress` channel the Android path already uses, so the
    // UpdatePanel can show a real progress bar instead of an opaque
    // spinner. Payload shape: { phase: "download"|"install", downloaded?, total? }.
    //
    // `download_and_install` blocks until BOTH the download finishes AND the
    // package is fully applied (on Linux this drives deb/rpm install through
    // an external pkexec/polkit step). Only after it returns Ok do we restart,
    // so we never race the installer. If it returns Err — the install failed
    // (e.g. user cancelled the polkit prompt) — we propagate the error to the
    // frontend instead of silently restarting/closing.
    let app_dl = app.clone();
    let downloaded = std::sync::atomic::AtomicU64::new(0);
    let app_done = app.clone();
    let on_chunk = move |chunk_len: usize, content_length: Option<u64>| {
        let total = downloaded.fetch_add(chunk_len as u64, std::sync::atomic::Ordering::Relaxed)
            + chunk_len as u64;
        let _ = app_dl.emit(
            "update-progress",
            serde_json::json!({
                "phase": "download",
                "downloaded": total,
                "total": content_length,
            }),
        );
    };
    let on_download_finished = move || {
        // Download done — the (potentially privileged, password-prompting)
        // package install begins now.
        let _ = app_done.emit(
            "update-progress",
            serde_json::json!({ "phase": "install" }),
        );
    };

    update
        .download_and_install(on_chunk, on_download_finished)
        .await
        .map_err(|e| UpdateError::Plugin(e.to_string()))?;

    // Install applied successfully — restart so the user lands on the new
    // version immediately.
    app.restart();
}
