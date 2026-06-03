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

/** Change the master password (vault must be unlocked). */
export async function vaultChangePassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  await invoke("vault_change_password", { oldPassword, newPassword });
}

/** Reset the vault: back up the encrypted file, delete it, and lock. Returns
 *  the backup path (if any). All secrets — and the encrypted host list, if it
 *  lived here — are gone. The escape hatch for a forgotten master password. */
export async function vaultReset(): Promise<string | null> {
  return await invoke<string | null>("vault_reset");
}

export interface VaultBackup {
  path: string;
  created: number; // unix seconds
}

/** List available vault backups (from prior resets), newest first. */
export async function vaultListBackups(): Promise<VaultBackup[]> {
  return await invoke<VaultBackup[]>("vault_list_backups");
}

/** Restore a backup over the vault file and lock. Unlock afterwards with the
 *  master password the backup was created under. */
export async function vaultRestoreBackup(path: string): Promise<void> {
  await invoke("vault_restore_backup", { path });
}

/** Conventional vault key for a host's saved password. */
export function hostPasswordKey(hostId: string): string {
  return `host.${hostId}.password`;
}
