// Unified app-settings store backed by localStorage.
// Migrates older isolated keys (`nexussh.advanced`, `nexussh.autoUpdate`) on
// first load so existing user preferences carry over from v0.0.3 alpha.

import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import type { ThemeId } from "./themes";
import type { FontId } from "./fonts";

export interface NexuSettings {
  theme: ThemeId;
  font: FontId;
  fontSize: number; // 11–20
  rainOn: boolean;
  rainDensity: number; // 10–28 cell px
  rainOpacity: number; // 0.10–0.80

  channel: "stable" | "beta" | "nightly";
  autoUpdate: boolean;
  verifySigs: boolean;

  defaultPort: number; // 1–65535
  defaultUser: string;
  timeout: number; // 5–60 seconds
  keepalive: number; // 0–120 seconds, 0 = off
  clickMode: "connect" | "select";
  restoreSession: boolean;
  autoReconnect: boolean;
  confirmClose: boolean;
  advanced: boolean;
}

export const DEFAULTS: NexuSettings = {
  theme: "matrix",
  font: "jetbrains",
  fontSize: 14,
  rainOn: false, // off by default; user opts in
  rainDensity: 16,
  rainOpacity: 0.35,
  channel: "stable",
  autoUpdate: true,
  verifySigs: true,
  defaultPort: 22,
  defaultUser: "root",
  timeout: 15,
  keepalive: 30,
  clickMode: "select",
  restoreSession: true,
  autoReconnect: false,
  confirmClose: true,
  advanced: false,
};

const STORAGE_KEY = "nexussh.settings.v1";
const LEGACY_ADVANCED = "nexussh.advanced";
const LEGACY_AUTOUPDATE = "nexussh.autoUpdateCheck";

function migrateLegacy(into: NexuSettings): NexuSettings {
  const adv = localStorage.getItem(LEGACY_ADVANCED);
  if (adv !== null) into.advanced = adv === "1";
  const au = localStorage.getItem(LEGACY_AUTOUPDATE);
  if (au !== null) into.autoUpdate = au !== "0";
  return into;
}

function load(): NexuSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NexuSettings>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return migrateLegacy({ ...DEFAULTS });
}

function save(s: NexuSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  // Keep legacy keys in sync so older code paths still read consistent values
  // while we migrate consumers.
  localStorage.setItem(LEGACY_ADVANCED, s.advanced ? "1" : "0");
  localStorage.setItem(LEGACY_AUTOUPDATE, s.autoUpdate ? "1" : "0");
}

// External store so multiple components stay in sync without prop-drilling.
type Listener = () => void;
const listeners = new Set<Listener>();
let current: NexuSettings = load();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot(): NexuSettings {
  return current;
}

export function getSettings(): NexuSettings {
  return current;
}

export function setSettings(patch: Partial<NexuSettings>) {
  current = { ...current, ...patch };
  save(current);
  emit();
}

export function resetSettings() {
  current = { ...DEFAULTS };
  save(current);
  emit();
}

/** React hook subscribing to the global settings store. */
export function useSettings(): [NexuSettings, (patch: Partial<NexuSettings>) => void] {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return [s, setSettings];
}

/** Hook variant for components that only need ONE field — avoids re-render
 *  when unrelated settings change. */
export function useSettingValue<K extends keyof NexuSettings>(
  key: K,
): NexuSettings[K] {
  const get = useCallback(() => current[key], [key]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Non-hook subscription for legacy plain-JS modules (`updater.ts` etc.). */
export function onSettingsChange(cb: (s: NexuSettings) => void): () => void {
  const wrapped: Listener = () => cb(current);
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

// Re-export to keep imports tidy in consumers.
export { useState, useEffect };
