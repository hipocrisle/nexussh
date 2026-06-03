mod android_updater;
mod bundle;
mod cleanup;
mod import_sources;
mod sftp;
mod ssh;
mod ssh_config;
mod sync;
mod updater;
mod vault;
mod vpn;

use std::sync::Arc;

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
    let _ = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::default())
        .title("NexuSSH")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .decorations(false)
        .build();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .manage(vault::VaultState::default())
        .manage(sync::SyncState::default())
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
            sftp::sftp_disconnect,
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
            ssh_config::read_ssh_config,
            ssh_config::expand_home,
            import_sources::read_import_sources,
            import_sources::read_text_file,
            vpn::vpn_parse_subscription,
            vpn::vpn_fetch_subscription,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
