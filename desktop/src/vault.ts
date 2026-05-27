// Vault CLI bridge via Tauri commands.

import { invoke } from "@tauri-apps/api/core";

export async function vaultGet(key: string): Promise<string> {
  return await invoke<string>("vault_get", { key });
}

export async function vaultKeys(): Promise<string[]> {
  return await invoke<string[]>("vault_keys");
}
