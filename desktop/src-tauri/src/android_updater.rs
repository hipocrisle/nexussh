// In-app updater for Android: download an APK to the app's cache and hand it
// to Android's PackageInstaller via an Intent.ACTION_VIEW. Android then shows
// its own "Install this app?" UI; we don't replace the binary ourselves.
//
// The whole pipeline only compiles on Android — on every other target the
// command is a no-op (returns Err) so the call sites can stay platform-blind.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
pub struct InstallApkArgs {
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AndroidUpdateInfo {
    pub version: String,
    pub current_version: String,
    pub url: String,
    pub notes: Option<String>,
}

/// Fetch `latest.json` from the releases endpoint (same URL that
/// tauri-plugin-updater uses on desktop) and decide if there's a newer
/// version than the bundled one. tauri-plugin-updater itself has no Android
/// support, so we read the manifest manually and let the JS side route the
/// returned URL into `android_install_apk`.
#[tauri::command]
pub async fn android_check_update(app: AppHandle) -> Result<Option<AndroidUpdateInfo>, String> {
    let cur = app.package_info().version.to_string();
    // Hard-coded to match the releases workflow. (The same URL also lives in
    // tauri.conf.json under plugins.updater.endpoints, but reading it through
    // the Tauri config API isn't worth the boilerplate for one string.)
    const ENDPOINT: &str =
        "https://github.com/hipocrisle/nexussh/releases/latest/download/latest.json";
    let body = tokio::task::spawn_blocking(|| -> Result<String, String> {
        ureq::get(ENDPOINT)
            .call()
            .map_err(|e| format!("fetch latest.json: {e}"))?
            .into_string()
            .map_err(|e| format!("read body: {e}"))
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse latest.json: {e}"))?;
    let remote = v
        .get("version")
        .and_then(|x| x.as_str())
        .ok_or("latest.json: missing version field")?
        .to_string();
    if !is_newer(&remote, &cur) {
        return Ok(None);
    }
    let notes = v.get("notes").and_then(|x| x.as_str()).map(String::from);
    let url = format!(
        "https://github.com/hipocrisle/nexussh/releases/download/v{remote}/app-universal-debug.apk"
    );
    Ok(Some(AndroidUpdateInfo {
        version: remote,
        current_version: cur,
        url,
        notes,
    }))
}

fn parse_semver(s: &str) -> (u32, u32, u32) {
    let mut it = s.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

fn is_newer(remote: &str, current: &str) -> bool {
    parse_semver(remote) > parse_semver(current)
}

#[cfg(target_os = "android")]
mod android_impl {
    use super::InstallApkArgs;
    use jni::objects::{JObject, JString, JValue};
    use std::fs::{create_dir_all, File};
    use std::io::Write;
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager};

    /// Download the APK into `cacheDir/updates/nexussh.apk`, then ask Android
    /// to open it as an `application/vnd.android.package-archive`. The user
    /// confirms the install in the system PackageInstaller dialog.
    pub fn install(app: AppHandle, args: InstallApkArgs) -> Result<(), String> {
        let cache_dir: PathBuf = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("cache_dir: {e}"))?;
        let updates_dir = cache_dir.join("updates");
        create_dir_all(&updates_dir).map_err(|e| format!("mkdir updates: {e}"))?;
        let apk_path = updates_dir.join("nexussh.apk");

        // Blocking download via ureq. APKs are big — this command is invoked
        // from a Tauri async command so blocking here is fine (Tokio will
        // hand the future to a thread).
        let resp = ureq::get(&args.url)
            .call()
            .map_err(|e| format!("download: {e}"))?;
        let mut reader = resp.into_reader();
        let mut file = File::create(&apk_path).map_err(|e| format!("create apk: {e}"))?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = std::io::Read::read(&mut reader, &mut buf)
                .map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
        }
        drop(file);

        // JNI: FileProvider.getUriForFile + Intent.ACTION_VIEW.
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("attach vm: {e}"))?;
        let mut env = vm.attach_current_thread().map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { JObject::from_raw(ctx.context().cast()) };

        // String pkg = activity.getPackageName();
        let pkg_j = env
            .call_method(&activity, "getPackageName", "()Ljava/lang/String;", &[])
            .map_err(|e| format!("getPackageName: {e}"))?
            .l()
            .map_err(|e| format!("getPackageName.l: {e}"))?;
        let pkg_jstr: JString = pkg_j.into();
        let pkg: String = env
            .get_string(&pkg_jstr)
            .map_err(|e| format!("pkg str: {e}"))?
            .into();
        let authorities = format!("{pkg}.fileprovider");

        // File apkFile = new File(apk_path);
        let path_jstr = env
            .new_string(apk_path.to_string_lossy().as_ref())
            .map_err(|e| format!("path str: {e}"))?;
        let file_class = env.find_class("java/io/File").map_err(|e| format!("File: {e}"))?;
        let apk_file = env
            .new_object(file_class, "(Ljava/lang/String;)V", &[(&path_jstr).into()])
            .map_err(|e| format!("new File: {e}"))?;

        // Uri uri = FileProvider.getUriForFile(activity, authorities, apkFile);
        let authorities_jstr = env
            .new_string(&authorities)
            .map_err(|e| format!("auth str: {e}"))?;
        let fp_class = env
            .find_class("androidx/core/content/FileProvider")
            .map_err(|e| format!("FileProvider: {e}"))?;
        let uri_obj = env
            .call_static_method(
                fp_class,
                "getUriForFile",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
                &[
                    (&activity).into(),
                    (&authorities_jstr).into(),
                    (&apk_file).into(),
                ],
            )
            .map_err(|e| format!("getUriForFile: {e}"))?
            .l()
            .map_err(|e| format!("getUriForFile.l: {e}"))?;

        // Intent intent = new Intent(Intent.ACTION_VIEW);
        let intent_class = env
            .find_class("android/content/Intent")
            .map_err(|e| format!("Intent: {e}"))?;
        let action_view_field = env
            .get_static_field(&intent_class, "ACTION_VIEW", "Ljava/lang/String;")
            .map_err(|e| format!("ACTION_VIEW: {e}"))?
            .l()
            .map_err(|e| format!("ACTION_VIEW.l: {e}"))?;
        let intent = env
            .new_object(
                &intent_class,
                "(Ljava/lang/String;)V",
                &[(&action_view_field).into()],
            )
            .map_err(|e| format!("new Intent: {e}"))?;

        // intent.setDataAndType(uri, "application/vnd.android.package-archive");
        let mime_jstr = env
            .new_string("application/vnd.android.package-archive")
            .map_err(|e| format!("mime str: {e}"))?;
        env.call_method(
            &intent,
            "setDataAndType",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
            &[(&uri_obj).into(), (&mime_jstr).into()],
        )
        .map_err(|e| format!("setDataAndType: {e}"))?;

        // FLAG_GRANT_READ_URI_PERMISSION (1) | FLAG_ACTIVITY_NEW_TASK (0x10000000)
        let flags: i32 = 1 | 0x10000000;
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(flags)],
        )
        .map_err(|e| format!("addFlags: {e}"))?;

        // activity.startActivity(intent);
        env.call_method(
            &activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[(&intent).into()],
        )
        .map_err(|e| format!("startActivity: {e}"))?;

        Ok(())
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_install_apk(app: AppHandle, args: InstallApkArgs) -> Result<(), String> {
    tokio::task::spawn_blocking(move || android_impl::install(app, args))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_install_apk(_app: AppHandle, _args: InstallApkArgs) -> Result<(), String> {
    Err("android_install_apk is only available on Android".into())
}
