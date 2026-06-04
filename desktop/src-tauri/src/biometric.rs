// Biometric (fingerprint / face) unlock for the vault on Android.
//
// Security model — the vault's data key (DEK) is wrapped by a hardware-backed
// Android Keystore key flagged "requires biometric auth" and stored on disk.
// On unlock the OS BiometricPrompt releases the keystore key, which decrypts the
// DEK, which decrypts the vault. The master password is NEVER stored; it stays
// the fallback (and is still required to change the password). Adding a new
// fingerprint invalidates the keystore key (setInvalidatedByBiometricEnrollment),
// forcing a password unlock — so biometrics can't be silently re-bound.
//
// The Kotlin side (BiometricVault, injected by patch-android-manifest.sh) runs
// the async BiometricPrompt and keystore crypto, exposing a tiny synchronous
// poll() the Rust side drains. All JNI goes through the WebView UI thread, the
// Tauri-blessed entry point (mirrors android_updater.rs).

use tauri::{AppHandle, Manager};

#[cfg(target_os = "android")]
use crate::vault::{self, VaultState};
#[cfg(target_os = "android")]
use tauri::State;

const WRAP_FILE: &str = "vault.biometric";

fn wrap_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join(WRAP_FILE))
}

/// Has the user enrolled biometric unlock? (the wrapped-DEK blob is on disk).
/// File-only check — no JNI, works on every platform.
#[tauri::command]
pub async fn vault_biometric_has_enrollment(app: AppHandle) -> Result<bool, String> {
    Ok(wrap_path(&app).map(|p| p.exists()).unwrap_or(false))
}

// ---------------- Android ----------------

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn vault_biometric_available(webview: tauri::Webview) -> Result<bool, String> {
    Ok(jni_call(&webview, JniOp::Available).await? == "true")
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn vault_biometric_enroll(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    // The vault must be unlocked so we can read its data key out to wrap.
    let dek = vault::dek_secret(&state).map_err(|e| e.to_string())?;
    jni_call(&webview, JniOp::StartEnroll(dek)).await?;
    let wrapped = poll_until_done(&webview).await?; // base64(iv|ct) from the keystore
    let path = wrap_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(&path, wrapped.as_bytes()).map_err(|e| format!("write wrap: {e}"))?;
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn vault_biometric_unlock(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let path = wrap_path(&app)?;
    let wrapped = std::fs::read_to_string(&path).map_err(|e| format!("read wrap: {e}"))?;
    jni_call(&webview, JniOp::StartUnlock(wrapped)).await?;
    let dek = poll_until_done(&webview).await?;
    vault::unlock_with_dek(&app, &state, &dek).map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn vault_biometric_disable(
    webview: tauri::Webview,
    app: AppHandle,
) -> Result<(), String> {
    let _ = jni_call(&webview, JniOp::DeleteKey).await; // best-effort keystore wipe
    if let Ok(path) = wrap_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[cfg(target_os = "android")]
async fn poll_until_done(webview: &tauri::Webview) -> Result<String, String> {
    // BiometricPrompt is async; drain the Kotlin result holder until it settles.
    for _ in 0..900 {
        match jni_call(webview, JniOp::Poll).await?.as_str() {
            "pending" => tokio::time::sleep(std::time::Duration::from_millis(120)).await,
            other => {
                if let Some(rest) = other.strip_prefix("ok:") {
                    return Ok(rest.to_string());
                }
                if let Some(rest) = other.strip_prefix("err:") {
                    return Err(rest.to_string());
                }
                return Err(format!("unexpected poll result: {other}"));
            }
        }
    }
    Err("biometric prompt timed out".into())
}

#[cfg(target_os = "android")]
enum JniOp {
    Available,
    StartEnroll(String),
    StartUnlock(String),
    Poll,
    DeleteKey,
}

#[cfg(target_os = "android")]
async fn jni_call(webview: &tauri::Webview, op: JniOp) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    webview
        .with_webview(move |pw| {
            pw.jni_handle().exec(move |env, activity, _wv| {
                let _ = tx.send(call_biometric(env, activity, op));
            });
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    rx.await.map_err(|e| format!("oneshot: {e}"))?
}

#[cfg(target_os = "android")]
fn call_biometric(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    op: JniOp,
) -> Result<String, String> {
    fn check<E: std::fmt::Display>(env: &mut jni::JNIEnv, ctx: &str, e: E) -> String {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
        format!("{ctx}: {e}")
    }

    // Resolve the app class through the activity's ClassLoader (system loader
    // can't see app classes) — same approach as android_updater/keepalive.
    let activity_class = env
        .call_method(activity, "getClass", "()Ljava/lang/Class;", &[])
        .map_err(|e| check(env, "getClass", e))?
        .l()
        .map_err(|e| check(env, "getClass.l", e))?;
    let cl_loader = env
        .call_method(
            &activity_class,
            "getClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .map_err(|e| check(env, "getClassLoader", e))?
        .l()
        .map_err(|e| check(env, "getClassLoader.l", e))?;
    let name = env
        .new_string("org.hipogas.nexussh.BiometricVault")
        .map_err(|e| check(env, "name str", e))?;
    let class_obj = env
        .call_method(
            &cl_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )
        .map_err(|e| check(env, "loadClass BiometricVault", e))?
        .l()
        .map_err(|e| check(env, "loadClass.l", e))?;
    let class = <jni::objects::JClass as From<jni::objects::JObject>>::from(class_obj);

    let out = match op {
        JniOp::Available => {
            let b = env
                .call_static_method(
                    &class,
                    "available",
                    "(Landroid/content/Context;)Z",
                    &[(&*activity).into()],
                )
                .map_err(|e| check(env, "available", e))?
                .z()
                .map_err(|e| check(env, "available.z", e))?;
            if b { "true".to_string() } else { "false".to_string() }
        }
        JniOp::Poll => {
            let s = env
                .call_static_method(&class, "poll", "()Ljava/lang/String;", &[])
                .map_err(|e| check(env, "poll", e))?
                .l()
                .map_err(|e| check(env, "poll.l", e))?;
            let jstr: jni::objects::JString = s.into();
            env.get_string(&jstr)
                .map_err(|e| check(env, "poll str", e))?
                .into()
        }
        JniOp::DeleteKey => {
            env.call_static_method(
                &class,
                "deleteKey",
                "(Landroid/content/Context;)V",
                &[(&*activity).into()],
            )
            .map_err(|e| check(env, "deleteKey", e))?;
            String::new()
        }
        JniOp::StartEnroll(arg) => {
            let js = env
                .new_string(&arg)
                .map_err(|e| check(env, "enroll arg", e))?;
            env.call_static_method(
                &class,
                "startEnroll",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[(&*activity).into(), (&js).into()],
            )
            .map_err(|e| check(env, "startEnroll", e))?;
            String::new()
        }
        JniOp::StartUnlock(arg) => {
            let js = env
                .new_string(&arg)
                .map_err(|e| check(env, "unlock arg", e))?;
            env.call_static_method(
                &class,
                "startUnlock",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[(&*activity).into(), (&js).into()],
            )
            .map_err(|e| check(env, "startUnlock", e))?;
            String::new()
        }
    };
    Ok(out)
}

// ---------------- desktop stubs ----------------

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn vault_biometric_available() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn vault_biometric_enroll() -> Result<(), String> {
    Err("biometric unlock is only available on Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn vault_biometric_unlock() -> Result<(), String> {
    Err("biometric unlock is only available on Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn vault_biometric_disable() -> Result<(), String> {
    Ok(())
}
