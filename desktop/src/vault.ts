// Vault — native age-encrypted credential store (passphrase-protected).
//
// The master password is the only key and is never written to disk; without
// it the vault file is undecryptable. Host passwords live here, never in
// plaintext hosts.json.

import { invoke } from "@tauri-apps/api/core";

const HAS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Broadcast so OTHER windows in this process re-gate their UI when the vault
 *  is locked here. Locking is global in Rust, but each window keeps its own
 *  `appLocked` flag + cached host list, so without this the second window
 *  stays unlocked and its host contents remain visible. */
export const VAULT_LOCKED_EVENT = "nexussh:vault-locked";
/** Counterpart of VAULT_LOCKED_EVENT: unlocking is also global in Rust, so a
 *  second window sitting on the lock screen should drop it without making the
 *  user re-enter the same master password. */
export const VAULT_UNLOCKED_EVENT = "nexussh:vault-unlocked";

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
  if (HAS_TAURI) {
    import("@tauri-apps/api/event")
      .then(({ emit }) => emit(VAULT_UNLOCKED_EVENT))
      .catch(() => {});
  }
}

export async function vaultLock(): Promise<void> {
  await invoke("vault_lock");
  if (HAS_TAURI) {
    import("@tauri-apps/api/event")
      .then(({ emit }) => emit(VAULT_LOCKED_EVENT))
      .catch(() => {});
  }
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

// --- Biometric unlock (Android) -------------------------------------------
// The vault data key is wrapped by a hardware-backed, fingerprint-gated Android
// Keystore key. Enroll while unlocked; then unlock with a fingerprint instead of
// the master password (which is never stored and stays the fallback).

/** Is biometric hardware available + enrolled on this device? (Android only.) */
export async function biometricAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("vault_biometric_available");
  } catch {
    return false;
  }
}

/** Has the user turned on biometric unlock for this vault? */
export async function biometricEnrolled(): Promise<boolean> {
  try {
    return await invoke<boolean>("vault_biometric_has_enrollment");
  } catch {
    return false;
  }
}

/** Turn on biometric unlock — prompts for a fingerprint and wraps the data key.
 *  Vault must be unlocked. */
export async function biometricEnroll(): Promise<void> {
  await invoke("vault_biometric_enroll");
}

/** Unlock the vault with a fingerprint (no master password). */
export async function biometricUnlock(): Promise<void> {
  await invoke("vault_biometric_unlock");
}

/** Turn off biometric unlock and wipe the stored wrapped key. */
export async function biometricDisable(): Promise<void> {
  await invoke("vault_biometric_disable");
}

/** Conventional vault key for a host's saved password. */
export function hostPasswordKey(hostId: string): string {
  return `host.${hostId}.password`;
}
