// Sync — encrypted host-list blob saved to user-chosen path.

import { invoke } from "@tauri-apps/api/core";

export interface SyncStatus {
  configured: boolean;
  unlocked: boolean;
  file_path: string | null;
  backend_label: string | null;
  file_exists: boolean;
  file_mtime: string | null;
}

export async function syncStatus(): Promise<SyncStatus> {
  return await invoke<SyncStatus>("sync_status");
}

export async function syncSetConfig(
  filePath: string,
  backendLabel: string,
): Promise<void> {
  await invoke("sync_set_config", { filePath, backendLabel });
}

export async function syncUnlock(password: string): Promise<void> {
  await invoke("sync_unlock", { password });
}

export async function syncLock(): Promise<void> {
  await invoke("sync_lock");
}

export async function syncPush(): Promise<void> {
  await invoke("sync_push");
}

export async function syncPull(): Promise<number> {
  return await invoke<number>("sync_pull");
}
