// Auto-update — thin wrapper around backend check_for_update / install_update.

import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  version: string;
  current_version: string;
  date: string | null;
  body: string | null;
  /** Set on Android: URL of the .apk to hand to PackageInstaller. */
  apk_url?: string;
  /** Set on Android: expected SHA-256 of the APK (verified before install). */
  apk_sha256?: string | null;
}

interface AndroidUpdateInfo {
  version: string;
  current_version: string;
  url: string;
  notes: string | null;
  sha256: string | null;
}

/** Best-effort detection of an Android Tauri runtime. The desktop updater
 *  plugin throws on Android, so we route there instead. */
function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (isAndroid()) {
    const a = await invoke<AndroidUpdateInfo | null>("android_check_update");
    if (!a) return null;
    return {
      version: a.version,
      current_version: a.current_version,
      date: null,
      body: a.notes,
      apk_url: a.url,
      apk_sha256: a.sha256,
    };
  }
  return await invoke<UpdateInfo | null>("check_for_update");
}

export async function installUpdate(info?: UpdateInfo): Promise<void> {
  if (isAndroid()) {
    if (!info?.apk_url) throw new Error("missing APK url");
    await invoke("android_install_apk", {
      args: { url: info.apk_url, sha256: info.apk_sha256 ?? null },
    });
    return;
  }
  await invoke("install_update");
}

const LAST_CHECK_LS = "nexussh.lastUpdateCheck";
const AUTO_CHECK_LS = "nexussh.autoUpdateCheck";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

export function isAutoCheckEnabled(): boolean {
  // Default ON unless user explicitly opted out.
  return localStorage.getItem(AUTO_CHECK_LS) !== "0";
}

export function setAutoCheckEnabled(v: boolean) {
  localStorage.setItem(AUTO_CHECK_LS, v ? "1" : "0");
}

/** Returns the last check timestamp in ms, or 0 if never. */
export function lastCheckAt(): number {
  const v = localStorage.getItem(LAST_CHECK_LS);
  return v ? parseInt(v, 10) : 0;
}

export function markChecked() {
  localStorage.setItem(LAST_CHECK_LS, String(Date.now()));
}

/** Returns the available update info if auto-check is due, else null.
 *  Silent on errors (network down, etc.) — UI shows nothing.
 *  Legacy 24h throttle — kept for callers that explicitly want it. */
export async function maybeAutoCheck(): Promise<UpdateInfo | null> {
  if (!isAutoCheckEnabled()) return null;
  const last = lastCheckAt();
  if (Date.now() - last < CHECK_INTERVAL_MS) return null;
  try {
    const info = await checkForUpdate();
    markChecked();
    return info;
  } catch {
    return null;
  }
}

/** Check on every app startup. Honors "auto-check disabled" setting.
 *  If the user previously chose "skip this version", returns null until
 *  a newer version appears. */
export async function startupCheck(): Promise<UpdateInfo | null> {
  if (!isAutoCheckEnabled()) return null;
  try {
    const info = await checkForUpdate();
    markChecked();
    if (info && skippedVersion() === info.version) return null;
    return info;
  } catch {
    return null;
  }
}

const SKIPPED_VERSION_LS = "nexussh.updateSkippedVersion";

export function skippedVersion(): string {
  return localStorage.getItem(SKIPPED_VERSION_LS) ?? "";
}

export function skipVersion(v: string) {
  localStorage.setItem(SKIPPED_VERSION_LS, v);
}

export function clearSkippedVersion() {
  localStorage.removeItem(SKIPPED_VERSION_LS);
}
