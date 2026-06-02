mod android_updater;
mod import_sources;
mod sftp;
mod ssh;
mod ssh_config;
mod sync;
mod updater;
mod vault;
mod vpn;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            sftp::sftp_connect,
            sftp::sftp_realpath,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_disconnect,
            vault::vault_set_paths,
            vault::vault_status,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_get,
            vault::vault_keys,
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
            vpn::vpn_parse_subscription,
            vpn::vpn_fetch_subscription,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
