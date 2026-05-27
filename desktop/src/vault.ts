// Vault — native age-encrypted credential store, cross-platform.

import { invoke } from "@tauri-apps/api/core";

export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  vault_path: string | null;
  key_path: string | null;
}

export async function vaultStatus(): Promise<VaultStatus> {
  return await invoke<VaultStatus>("vault_status");
}

export async function vaultSetPaths(
  vaultPath: string,
  keyPath: string,
): Promise<void> {
  await invoke("vault_set_paths", { vaultPath, keyPath });
}

export async function vaultUnlock(): Promise<void> {
  await invoke("vault_unlock");
}

export async function vaultLock(): Promise<void> {
  await invoke("vault_lock");
}

export async function vaultGet(key: string): Promise<string> {
  return await invoke<string>("vault_get", { key });
}

export async function vaultKeys(): Promise<string[]> {
  return await invoke<string[]>("vault_keys");
}
