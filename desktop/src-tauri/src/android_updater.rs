// In-app updater for Android. Downloads the new APK to the app cache and
// hands it to Android's PackageInstaller via Intent.ACTION_VIEW + a
// FileProvider URI. The user only sees the system "Install update?" dialog
// — no browser hop, no notification, no separate download.
//
// Access to JNI is via `webview.jni_handle().exec(...)`, which is the
// Tauri-blessed entry point (runs on the WebView's UI thread, where Android
// Activity calls are legal).

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

#[tauri::command]
pub async fn android_check_update(app: AppHandle) -> Result<Option<AndroidUpdateInfo>, String> {
    let cur = app.package_info().version.to_string();
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
#[tauri::command]
pub async fn android_install_apk(
    webview: tauri::Webview,
    app: AppHandle,
    args: InstallApkArgs,
) -> Result<(), String> {
    use std::fs::{create_dir_all, File};
    use std::io::Write;
    use tauri::Manager;

    // 1) Download the APK to cacheDir/updates/nexussh.apk. Blocking I/O on
    //    the Tokio blocking pool.
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache_dir: {e}"))?;
    let apk_path: std::path::PathBuf = cache_dir.join("updates").join("nexussh.apk");
    let url = args.url.clone();
    let apk_path_for_dl = apk_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if let Some(parent) = apk_path_for_dl.parent() {
            create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let resp = ureq::get(&url)
            .call()
            .map_err(|e| format!("download: {e}"))?;
        let mut reader = resp.into_reader();
        let mut file =
            File::create(&apk_path_for_dl).map_err(|e| format!("create apk: {e}"))?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = std::io::Read::read(&mut reader, &mut buf)
                .map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    // 2) Hand the file to Android's PackageInstaller through a FileProvider
    //    URI + Intent.ACTION_VIEW. Runs on the WebView's UI thread.
    //
    // `webview.jni_handle()` lives on `PlatformWebview`, which we reach via
    // `Webview::with_webview(|pw| ...)`. The closure runs on the UI thread.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let apk_path_str = apk_path.to_string_lossy().into_owned();
    webview
        .with_webview(move |pw| {
            pw.jni_handle().exec(move |env, activity, _wv| {
                let res = jni_install(env, activity, &apk_path_str);
                let _ = tx.send(res);
            });
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    rx.await
        .map_err(|e| format!("oneshot: {e}"))??;
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_install_apk(
    _app: AppHandle,
    _args: InstallApkArgs,
) -> Result<(), String> {
    Err("android_install_apk is only available on Android".into())
}

#[cfg(target_os = "android")]
fn jni_install(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    apk_path: &str,
) -> Result<(), String> {
    use jni::objects::{JObject, JString, JValue};
    use jni::sys::jint;

    // String pkg = activity.getPackageName();
    let pkg_obj = env
        .call_method(activity, "getPackageName", "()Ljava/lang/String;", &[])
        .map_err(|e| format!("getPackageName: {e}"))?
        .l()
        .map_err(|e| format!("getPackageName.l: {e}"))?;
    let pkg_jstr: JString = pkg_obj.into();
    let pkg: String = env
        .get_string(&pkg_jstr)
        .map_err(|e| format!("pkg str: {e}"))?
        .into();
    let authorities = format!("{pkg}.fileprovider");

    // File apkFile = new File(apkPath);
    let path_jstr = env
        .new_string(apk_path)
        .map_err(|e| format!("path str: {e}"))?;
    let file_class = env
        .find_class("java/io/File")
        .map_err(|e| format!("File class: {e}"))?;
    let apk_file: JObject = env
        .new_object(file_class, "(Ljava/lang/String;)V", &[(&path_jstr).into()])
        .map_err(|e| format!("new File: {e}"))?;

    // Uri uri = FileProvider.getUriForFile(activity, authorities, apkFile);
    let authorities_jstr = env
        .new_string(&authorities)
        .map_err(|e| format!("auth str: {e}"))?;
    let fp_class = env
        .find_class("androidx/core/content/FileProvider")
        .map_err(|e| format!("FileProvider class: {e}"))?;
    let uri = env
        .call_static_method(
            fp_class,
            "getUriForFile",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
            &[
                (&*activity).into(),
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
        .map_err(|e| format!("Intent class: {e}"))?;
    let action_view = env
        .get_static_field(&intent_class, "ACTION_VIEW", "Ljava/lang/String;")
        .map_err(|e| format!("ACTION_VIEW: {e}"))?
        .l()
        .map_err(|e| format!("ACTION_VIEW.l: {e}"))?;
    let intent: JObject = env
        .new_object(&intent_class, "(Ljava/lang/String;)V", &[(&action_view).into()])
        .map_err(|e| format!("new Intent: {e}"))?;

    // intent.setDataAndType(uri, "application/vnd.android.package-archive");
    let mime_jstr = env
        .new_string("application/vnd.android.package-archive")
        .map_err(|e| format!("mime str: {e}"))?;
    env.call_method(
        &intent,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[(&uri).into(), (&mime_jstr).into()],
    )
    .map_err(|e| format!("setDataAndType: {e}"))?;

    // intent.addFlags(FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK).
    let flags: jint = 1 | 0x1000_0000;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(flags)],
    )
    .map_err(|e| format!("addFlags: {e}"))?;

    // activity.startActivity(intent);
    env.call_method(
        activity,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[(&intent).into()],
    )
    .map_err(|e| format!("startActivity: {e}"))?;

    Ok(())
}
