//! Auto-update — лёгкая обёртка над tauri-plugin-updater.
//!
//! Публичный ключ задан в `tauri.conf.json`. Эндпоинт выбирается ПО КАНАЛУ
//! (stable/beta) — фронт передаёт `channel`, бэкенд строит updater на
//! катящийся манифест `channel-<c>/latest.json`. Без канала используется
//! зашитый в конфиг эндпоинт (back-compat для старых установок).
//!
//! `version_comparator` всегда отвечает "да, это апдейт", чтобы ОДИН и тот же
//! поток обслуживал и обычные обновления, и смену канала НА ЛЕТУ (beta→stable —
//! это даунгрейд, который дефолтный semver-компаратор отверг бы). Решение
//! «показывать ли кнопку» принимает фронт, сравнивая `version` vs
//! `current_version`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

/// Rolling per-channel manifest URL. Unknown/None → None (fall back to the
/// endpoint baked into tauri.conf.json, for back-compat with old installs).
fn channel_endpoint(channel: Option<&str>) -> Option<String> {
    let c = match channel {
        Some("beta") => "beta",
        Some("stable") => "stable",
        _ => return None,
    };
    Some(format!(
        "https://github.com/hipocrisle/nexussh/releases/download/channel-{c}/latest.json"
    ))
}

/// Build a channel-aware updater that treats ANY remote release as installable
/// (so on-the-fly channel switches, including downgrades, work). The frontend
/// gates the actual prompt on `version != current_version`.
fn build_updater(app: &AppHandle, channel: Option<&str>) -> Result<Updater, UpdateError> {
    let mut b = app
        .updater_builder()
        .version_comparator(|_current, _update| true);
    if let Some(ep) = channel_endpoint(channel) {
        let url: Url = ep
            .parse()
            .map_err(|e| UpdateError::Plugin(format!("bad endpoint url: {e}")))?;
        b = b
            .endpoints(vec![url])
            .map_err(|e| UpdateError::Plugin(e.to_string()))?;
    }
    b.build().map_err(|e| UpdateError::Plugin(e.to_string()))
}

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
pub async fn check_for_update(
    app: AppHandle,
    channel: Option<String>,
) -> Result<Option<UpdateInfo>, UpdateError> {
    let updater = build_updater(&app, channel.as_deref())?;
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
pub async fn install_update(app: AppHandle, channel: Option<String>) -> Result<(), UpdateError> {
    let updater = build_updater(&app, channel.as_deref())?;
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
