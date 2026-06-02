// Vault — native age-encrypted credential store (passphrase-protected).
//
// The master password is the only key and is never written to disk; without
// it the vault file is undecryptable. Host passwords live here, never in
// plaintext hosts.json.

import { invoke } from "@tauri-apps/api/core";

export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  vault_path: string | null;
}

export async function vaultStatus(): Promise<VaultStatus> {
  return await invoke<VaultStatus>("vault_status");
}

/** Create a brand-new empty vault encrypted with `masterPassword`, leaving
 *  it unlocked. Errors if a vault already exists. */
export async function vaultCreate(masterPassword: string): Promise<void> {
  await invoke("vault_create", { masterPassword });
}

export async function vaultUnlock(masterPassword: string): Promise<void> {
  await invoke("vault_unlock", { masterPassword });
}

export async function vaultLock(): Promise<void> {
  await invoke("vault_lock");
}

export async function vaultGet(key: string): Promise<string> {
  return await invoke<string>("vault_get", { key });
}

/** Store (or overwrite) a secret and re-encrypt the vault to disk. */
export async function vaultSet(key: string, value: string): Promise<void> {
  await invoke("vault_set", { key, value });
}

export async function vaultDelete(key: string): Promise<void> {
  await invoke("vault_delete", { key });
}

export async function vaultKeys(): Promise<string[]> {
  return await invoke<string[]>("vault_keys");
}

/** Conventional vault key for a host's saved password. */
export function hostPasswordKey(hostId: string): string {
  return `host.${hostId}.password`;
}
