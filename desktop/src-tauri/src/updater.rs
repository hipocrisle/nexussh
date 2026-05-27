//! Auto-update — лёгкая обёртка над tauri-plugin-updater.
//!
//! Эндпоинт + публичный ключ заданы в `tauri.conf.json`. Frontend дёргает
//! `check_for_update`, получает Option<UpdateInfo>; если Some — может вызвать
//! `install_update`, который скачает, верифицирует подпись и перезапустит app.

use serde::Serialize;
use tauri::AppHandle;
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
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| UpdateError::Plugin(e.to_string()))?;
    // After install_update finishes the new binary is on disk; restart so
    // the user lands on the new version immediately.
    app.restart();
}
