mod android_keepalive;
mod android_updater;
mod biometric;
mod bundle;
mod cleanup;
mod history;
mod import_sources;
mod localfs;
mod sftp;
mod ssh;
mod ssh_config;
mod sshlog;
mod sync;
mod tunnel;
mod updater;
mod vault;
mod vpn;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Cached result of compositor detection. Computed ONCE on the main GTK thread
/// in the `.setup()` hook (GDK is thread-affine — calling it from a Tauri
/// command's worker thread can panic / return garbage, which is why the earlier
/// per-command detection silently failed and corners stayed square). Defaults
/// to `false` (no rounding) until setup runs; the webview only loads — and thus
/// can only `invoke("window_composited")` — after setup completes, so there's no
/// race.
static COMPOSITED: AtomicBool = AtomicBool::new(false);

/// Whether the running session has a compositing window manager.
///
/// We only enable window transparency (which the frontend pairs with rounded
/// corners) when a compositor is present. On a machine WITHOUT one, a
/// transparent borderless window renders BLACK corners instead of see-through
/// ones — worse than plain square corners. So transparency is gated on this.
///
/// Detection prefers GDK (`Screen::is_composited()`), which is authoritative on
/// both X11 (reads `_NET_WM_CM_Sn`) and Wayland (always composited). GDK is
/// valid at our call sites (the `window_composited` command and opening a second
/// window) because tao/GTK has already initialised it by then. If for any reason
/// the GDK screen can't be obtained we fall back to an env
/// heuristic: a Wayland session always has a compositor; otherwise we assume
/// one is present (the common case across desktop environments), since the only
/// real failure mode we're guarding against — a transparent window on a bare
/// X11 server with no compositor — is rare and the heuristic only runs when GDK
/// already failed.
#[cfg(target_os = "linux")]
fn detect_composited() -> bool {
    // `is_composited()` is provided by the `ScreenExt` trait in gtk3-rs, so it
    // must be in scope (glob import is safe — only a warning if ever inherent).
    use gtk::gdk::prelude::*;
    // GDK: the reliable path. `gdk::Screen::default()` is valid once GTK is up
    // (true inside Tauri's setup hook). `gtk::gdk` re-exports the gdk crate.
    if let Some(screen) = gtk::gdk::Screen::default() {
        return screen.is_composited();
    }
    // Fallback heuristic — only reached if there is no default GDK screen.
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
    if wayland {
        return true; // Wayland always composites.
    }
    // X11 (or unknown): assume a compositor is present — most DEs composite,
    // and over-assuming here only costs black corners on the rare bare-X11 box,
    // which the GDK path above would normally have caught.
    true
}

/// Non-Linux platforms don't use the transparency-gated rounding at all; report
/// "not composited" so the shared window-builder simply skips `.transparent`.
#[cfg(not(target_os = "linux"))]
fn detect_composited() -> bool {
    false
}

/// Exposed to the frontend so it rounds the borderless Linux window corners
/// (transparent background outside the radius) ONLY when a compositor can
/// actually blend that transparency. Without one, the frontend keeps a fully
/// opaque square background — so even though the window is created transparent,
/// no pixel is left see-through and there are no black corners.
#[tauri::command]
fn window_composited() -> bool {
    COMPOSITED.load(Ordering::Relaxed)
}

/// Force WebKitGTK to recomposite the transparent window so the rounded corners
/// show on launch. WebKitGTK paints the corners OPAQUE until a real GTK
/// size-allocate; a programmatic Tauri `set_size` doesn't reliably trigger one
/// (coalesced, or rounded away on HiDPI), but a native `gtk_window.resize()`
/// held for a main-loop tick does — the same path a manual edge-drag takes. We
/// bump the height +4px and revert it 220ms later via a glib timeout (so the +4
/// actually commits a size-allocate in between). Linux + compositor only.
#[tauri::command]
fn nudge_repaint(window: tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        if !COMPOSITED.load(Ordering::Relaxed) {
            return;
        }
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            use gtk::prelude::*;
            if let Ok(win) = w.gtk_window() {
                let width = win.allocated_width().max(1);
                let height = win.allocated_height().max(1);
                win.resize(width, height + 4);
                let revert = win.clone();
                let _ = gtk::glib::timeout_add_local_once(
                    std::time::Duration::from_millis(220),
                    move || {
                        revert.resize(width, height);
                    },
                );
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
    }
}

/// A second launch of the app is collapsed into the already-running instance by
/// the single-instance plugin; instead of forking a second process that would
/// race the same hosts.json / vault.age files, we open a fresh window in THIS
/// process. All windows then share Rust state and cross-window events.
#[cfg(desktop)]
fn open_extra_window(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("main-{n}");
    // Match the main window's transparency so secondary windows round their
    // corners too — but only with a compositor (else opaque/square, no black
    // corners). Builder windows don't inherit the config's `transparent`, so
    // set it explicitly. detect_composited() is non-Linux-safe (returns false).
    let _ = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::default())
        .title("NexuSSH")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .decorations(false)
        .transparent(COMPOSITED.load(Ordering::Relaxed))
        .build();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMABUF renderer white-screens on machines without a working
    // GPU compositor — VMs, headless/remote desktops, some Nvidia setups. The
    // bundled WebKit in our AppImage is especially prone to it (the system
    // WebKit a .deb uses tends to be fine). Force the fallback renderer before
    // any GTK/WebView init so the window actually paints everywhere.
    #[cfg(target_os = "linux")]
    {
        // Defensive set for blank-WebKitGTK-window cases (VMs, odd GL stacks —
        // common across a mixed distro fleet). Disable the DMABUF renderer and
        // accelerated compositing, and force Mesa software GL so the page paints
        // even with no usable hardware GL context.
        for (k, v) in [
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            ("LIBGL_ALWAYS_SOFTWARE", "1"),
        ] {
            if std::env::var_os(k).is_none() {
                std::env::set_var(k, v);
            }
        }
        // Redirect native stderr (WebKit/GL/GTK warnings) to ~/nexussh-debug.log
        // so a blank window stays diagnosable WITHOUT a terminal — the user just
        // opens the file. Unconditional for now while we chase the white screen;
        // remove once Linux rendering is settled. Harmless on a good run.
        if let Ok(home) = std::env::var("HOME") {
            if let Ok(f) = std::fs::File::create(format!("{home}/nexussh-debug.log")) {
                use std::os::unix::io::IntoRawFd;
                unsafe { libc::dup2(f.into_raw_fd(), 2) };
            }
        }
    }

    // Capture russh's handshake/auth tracing into an in-memory ring so a failed
    // connect can show why (KEX mismatch, host-key reject, disconnect reason).
    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;
        use tracing_subscriber::Layer;
        let _ = tracing_subscriber::registry()
            .with(sshlog::RingLayer.with_filter(tracing_subscriber::filter::EnvFilter::new(
                "russh=debug,russh_keys=debug,russh_sftp=info",
            )))
            .try_init();
    }

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // Single-instance must be registered first. Desktop only — mobile is always
    // a single process with one window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            open_extra_window(app);
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(ssh::SessionManager::new()))
        .manage(Arc::new(sftp::SftpManager::new()))
        .manage(Arc::new(sftp::CancelRegistry::new()))
        .manage(Arc::new(tunnel::TunnelManager::new()))
        .manage(vault::VaultState::default())
        .manage(sync::SyncState::default())
        .manage(history::HistoryState::new())
        .setup(|app| {
            // Detect the compositor ONCE here — `.setup()` runs on the main GTK
            // thread, so the GDK call inside detect_composited() is safe (unlike
            // from a command's worker thread). Cache it for window_composited()
            // and open_extra_window(). No-op on non-Linux (detect → false).
            COMPOSITED.store(detect_composited(), Ordering::Relaxed);
            // Trim the history store to its size/age limits at startup (mtime +
            // size only, no vault needed). Best-effort — never block launch.
            let _ = history::prune(&app.handle());
            // Background ticker: flush idle history buffers so a session that
            // stopped producing output still gets its last lines on disk (the
            // per-output time-flush can't fire when no output is arriving).
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick =
                        tokio::time::interval(std::time::Duration::from_secs(1));
                    loop {
                        tick.tick().await;
                        handle.state::<history::HistoryState>().flush_stale();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_send,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_ready,
            ssh::known_hosts_to_vault,
            ssh::known_hosts_from_vault,
            sftp::sftp_connect,
            sftp::sftp_realpath,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_chmod,
            sftp::sftp_cancel,
            sftp::sftp_disconnect,
            localfs::fs_local_home,
            localfs::fs_local_list,
            localfs::fs_local_size,
            tunnel::ssh_tunnel_open,
            tunnel::ssh_tunnel_close,
            tunnel::ssh_tunnel_list,
            vault::vault_status,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_get,
            vault::vault_set,
            vault::vault_delete,
            vault::vault_keys,
            vault::vault_change_password,
            vault::vault_reset,
            vault::vault_list_backups,
            vault::vault_restore_backup,
            cleanup::purge_legacy_sessions,
            bundle::bundle_export,
            bundle::bundle_import,
            sync::sync_set_config,
            sync::sync_status,
            sync::sync_unlock,
            sync::sync_lock,
            sync::sync_push,
            sync::sync_pull,
            updater::check_for_update,
            updater::install_update,
            android_updater::android_install_apk,
            android_updater::android_check_update,
            android_keepalive::android_keepalive,
            biometric::vault_biometric_available,
            biometric::vault_biometric_has_enrollment,
            biometric::vault_biometric_enroll,
            biometric::vault_biometric_unlock,
            biometric::vault_biometric_disable,
            sshlog::ssh_debug_log,
            ssh_config::read_ssh_config,
            ssh_config::expand_home,
            import_sources::read_import_sources,
            import_sources::read_text_file,
            vpn::vpn_parse_subscription,
            vpn::vpn_fetch_subscription,
            window_composited,
            nudge_repaint,
            history::history_list,
            history::history_read,
            history::history_search,
            history::history_delete,
            history::history_clear,
            history::history_stats,
            history::history_start,
            history::history_pause,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
