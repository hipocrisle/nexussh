// Account-based sync — typed Tauri command wrappers (Phase 1, no UI yet).
//
// ONE master password serves both the local vault and the account: the password
// passed here MUST be the same one used to unlock/create the vault (see the Rust
// `account.rs` module docs). Crypto happens entirely in Rust via the Phase-0
// `account_crypto` primitives; the server only ever sees ciphertext + metadata.

import { invoke } from "@tauri-apps/api/core";

/** Snapshot of account + sync state (no secrets). */
export interface AccountStatus {
  /** A user key is held in memory this session (logged in). */
  logged_in: boolean;
  username: string | null;
  totp_enabled: boolean;
  /** Wall-clock ms of the last successful sync, or null. */
  last_sync_at: number | null;
  server_url: string;
  /** True once a username has been registered/logged-in on this device. */
  configured: boolean;
}

/** Result of registration — recovery_key is shown ONCE (emergency kit). */
export interface RegisterResult {
  user_id: string;
  /** Human-readable recovery key. Persist nowhere; show the user once. */
  recovery_key: string;
}

export interface LoginResult {
  user_id: string;
  totp_enabled: boolean;
}

export interface TotpEnroll {
  secret: string;
  otpauth_url: string;
}

/** Outcome of a sync run. */
export interface SyncReport {
  pulled: number;
  pushed: number;
  deleted_locally: number;
  conflicts: number;
  latest_rev: number;
}

/** Error string the login command rejects with when a TOTP code is required.
 *  The UI catches this to prompt for the 2FA code, then retries `accountLogin`
 *  with `totp` set. */
export const TOTP_REQUIRED_ERROR = "totp required";

export async function accountStatus(): Promise<AccountStatus> {
  return await invoke<AccountStatus>("account_status");
}

export async function accountSetServer(url: string): Promise<void> {
  await invoke("account_set_server", { url });
}

/** Register a new account. Requires the vault to be unlocked with the SAME
 *  password. Returns the recovery key to show once. */
export async function accountRegister(
  password: string,
  username: string,
): Promise<RegisterResult> {
  return await invoke<RegisterResult>("account_register", { password, username });
}

/** Log in. If 2FA is enabled and no `totp` is supplied, this rejects with
 *  `TOTP_REQUIRED_ERROR`; re-call with the code. */
export async function accountLogin(
  password: string,
  username: string,
  totp?: string,
): Promise<LoginResult> {
  return await invoke<LoginResult>("account_login", { password, username, totp });
}

export async function accountLogout(): Promise<void> {
  await invoke("account_logout");
}

/** Begin TOTP enrollment — returns the shared secret + otpauth:// URL for a QR
 *  code. Call `accountTotpVerify` with a code to finish and get recovery codes. */
export async function accountTotpEnroll(): Promise<TotpEnroll> {
  return await invoke<TotpEnroll>("account_totp_enroll");
}

/** Verify a TOTP code to finish enrollment; returns one-time recovery codes. */
export async function accountTotpVerify(code: string): Promise<string[]> {
  return await invoke<string[]>("account_totp_verify", { code });
}

/** Run a full sync now (pull-then-push, last-writer-wins). Requires logged in +
 *  vault unlocked. */
export async function accountSyncNow(): Promise<SyncReport> {
  return await invoke<SyncReport>("account_sync_now");
}
