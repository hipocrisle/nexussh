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

/** Read the selected release channel from the settings store WITHOUT React
 *  (the updater runs outside components). Defaults to "stable". */
function currentChannel(): "stable" | "beta" {
  try {
    const raw = localStorage.getItem("nexussh.settings.v1");
    if (raw) {
      const s = JSON.parse(raw) as { channel?: string };
      if (s.channel === "beta") return "beta";
    }
  } catch {
    /* ignore */
  }
  return "stable";
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
  // The backend always reports the channel's latest as an "update" (so channel
  // switches incl. downgrades work). Treat same-version as "no update" here so
  // every caller keeps its "non-null ⇒ actionable" contract. A different
  // version — higher OR lower (channel switch) — is actionable.
  //
  // Retry transient failures (a network blip, or the brief window while a new
  // release's manifest asset is being swapped on GitHub) before surfacing an
  // error — otherwise a single hiccup shows "error sending request".
  const ch = currentChannel();
  let lastErr: unknown;
  let r: UpdateInfo | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 1500));
    try {
      r = await invoke<UpdateInfo | null>("check_for_update", { channel: ch });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr !== undefined) throw lastErr;
  if (r && r.version === r.current_version) return null;
  return r;
}

export async function installUpdate(info?: UpdateInfo): Promise<void> {
  if (isAndroid()) {
    if (!info?.apk_url) throw new Error("missing APK url");
    await invoke("android_install_apk", {
      args: { url: info.apk_url, sha256: info.apk_sha256 ?? null },
    });
    return;
  }
  await invoke("install_update", { channel: currentChannel() });
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
