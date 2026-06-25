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

fn chan_slug(channel: Option<&str>) -> Option<&'static str> {
    match channel {
        Some("beta") => Some("beta"),
        Some("stable") => Some("stable"),
        _ => None,
    }
}

/// Rolling per-channel manifest URL on GitHub releases (PRIMARY). Unknown/None →
/// None (then the endpoint baked into tauri.conf.json is used, for back-compat).
fn channel_endpoint(channel: Option<&str>) -> Option<String> {
    let c = chan_slug(channel)?;
    Some(format!(
        "https://github.com/hipocrisle/nexussh/releases/download/channel-{c}/latest.json"
    ))
}

/// Self-hosted manifest URL (FALLBACK), served from the RU node behind
/// upd.hipogas.org — a different domain/IP than GitHub's release CDN. When
/// GitHub's CDN is unreachable (e.g. a poisoned OS DNS cache for the
/// githubusercontent hosts) the updater still finds the update here. The
/// installer URLs inside this manifest also point at upd.hipogas.org, so the
/// whole update path can avoid GitHub.
fn selfhost_endpoint(channel: Option<&str>) -> Option<String> {
    let c = chan_slug(channel)?;
    Some(format!("https://upd.hipogas.org/nexussh/{c}/latest.json"))
}

/// Build a channel-aware updater that treats ANY remote release as installable
/// (so on-the-fly channel switches, including downgrades, work). The frontend
/// gates the actual prompt on `version != current_version`.
///
/// Endpoints are tried in order: self-hosted feed (primary) then GitHub
/// (fallback). The self-host is mirrored FRESH via the GitHub API, whereas the
/// GitHub release CDN serves a STALE cached `latest.json` (fixed asset name) —
/// trying GitHub first made the client install several older stable builds in a
/// row before catching up. A short per-request timeout fails over quickly.
fn build_updater(app: &AppHandle, channel: Option<&str>) -> Result<Updater, UpdateError> {
    let mut b = app
        .updater_builder()
        .version_comparator(|_current, _update| true)
        .timeout(std::time::Duration::from_secs(12));
    let mut eps: Vec<Url> = Vec::new();
    if let Some(ep) = selfhost_endpoint(channel) {
        eps.push(
            ep.parse()
                .map_err(|e| UpdateError::Plugin(format!("bad endpoint url: {e}")))?,
        );
    }
    if let Some(ep) = channel_endpoint(channel) {
        eps.push(
            ep.parse()
                .map_err(|e| UpdateError::Plugin(format!("bad fallback url: {e}")))?,
        );
    }
    if !eps.is_empty() {
        b = b
            .endpoints(eps)
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
    // True ONLY when the check is triggered by an explicit channel switch — then
    // an older remote (e.g. beta→stable) is a legit "update". For ordinary checks
    // (auto / manual button, same channel) downgrades are suppressed so a stale
    // self-host fallback feed can't prompt a rollback to an older version.
    allow_downgrade: Option<bool>,
) -> Result<Option<UpdateInfo>, UpdateError> {
    let updater = build_updater(&app, channel.as_deref())?;
    let update = updater
        .check()
        .await
        .map_err(|e| UpdateError::Plugin(e.to_string()))?;
    let Some(u) = update else { return Ok(None) };

    // Downgrade-guard: the comparator above accepts ANY remote (so channel
    // switches work), so here we drop remote <= current unless downgrades were
    // explicitly allowed. Semver-aware (beta.13 > beta.12). If either version is
    // unparseable we don't block — fall through and let the frontend decide.
    if !allow_downgrade.unwrap_or(false) {
        if let (Ok(remote), Ok(cur)) = (
            semver::Version::parse(&u.version),
            semver::Version::parse(&u.current_version),
        ) {
            if remote <= cur {
                return Ok(None);
            }
        }
    }

    Ok(Some(UpdateInfo {
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
