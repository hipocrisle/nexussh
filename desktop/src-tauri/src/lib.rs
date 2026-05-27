mod ssh;
mod sync;
mod vault;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(ssh::SessionManager::new()))
        .manage(vault::VaultState::default())
        .manage(sync::SyncState::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_send,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
