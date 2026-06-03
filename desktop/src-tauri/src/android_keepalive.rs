// Keep SSH sessions alive when the app is backgrounded or the screen is locked.
//
// Without this, Android freezes/caches the process within seconds of leaving
// the foreground — the tokio SSH read loop stops being scheduled and the
// connection dies (the "drops when minimised" bug). A foreground Service +
// partial wake lock keeps the process scheduled and the socket alive, the same
// way Termius does it.
//
// The JS side calls `android_keepalive(on)` when the connected-session count
// crosses 0↔N. Starting/stopping the Service goes through JNI on the WebView UI
// thread — the Tauri-blessed entry point, mirroring android_updater.rs.

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_keepalive(webview: tauri::Webview, on: bool) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    webview
        .with_webview(move |pw| {
            pw.jni_handle().exec(move |env, activity, _wv| {
                let _ = tx.send(jni_keepalive(env, activity, on));
            });
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    rx.await.map_err(|e| format!("oneshot: {e}"))?
}

// Desktop has no equivalent — keep the command registered so the JS side can
// call it unconditionally without a platform check (no-op here).
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_keepalive(on: bool) -> Result<(), String> {
    let _ = on;
    Ok(())
}

#[cfg(target_os = "android")]
fn jni_keepalive(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    on: bool,
) -> Result<(), String> {
    fn check<E: std::fmt::Display>(env: &mut jni::JNIEnv, ctx: &str, e: E) -> String {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
        format!("{ctx}: {e}")
    }

    // env.find_class uses the system classloader, which can't see app classes —
    // resolve KeepAliveService through the activity's ClassLoader (same trick
    // android_updater.rs uses for androidx FileProvider).
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
    let svc_name = env
        .new_string("org.hipogas.nexussh.KeepAliveService")
        .map_err(|e| check(env, "svc name", e))?;
    let svc_class_obj = env
        .call_method(
            &cl_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&svc_name).into()],
        )
        .map_err(|e| check(env, "loadClass KeepAliveService", e))?
        .l()
        .map_err(|e| check(env, "loadClass.l", e))?;
    let svc_class = <jni::objects::JClass as From<jni::objects::JObject>>::from(svc_class_obj);

    // KeepAliveService.start(activity) / .stop(activity) — both take a Context.
    let method = if on { "start" } else { "stop" };
    env.call_static_method(
        svc_class,
        method,
        "(Landroid/content/Context;)V",
        &[(&*activity).into()],
    )
    .map_err(|e| check(env, method, e))?;

    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        return Err(format!("KeepAliveService.{method} threw, see logcat"));
    }
    Ok(())
}
