// Host-record CRUD backed by Tauri Store (JSON file in app data dir).
// File path: %APPDATA%/org.hipogas.nexussh/hosts.json on Windows,
//            ~/.local/share/org.hipogas.nexussh/hosts.json on Linux/Mac.
//
// Schema is intentionally simple — sync layer in Phase 5 will wrap this with
// AES-256-GCM encryption before writing to the user-chosen sync folder.

import { load, Store } from "@tauri-apps/plugin-store";
import { syncStatus, syncPush } from "./sync";

export interface HostRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth:
    | { kind: "password"; password: string }
    | { kind: "key"; path: string; passphrase?: string }
    | { kind: "vault"; key: string };
  /** Optional grouping/folder name */
  group?: string;
  /** ISO timestamp of last successful connection — for sorting */
  lastUsedAt?: string;
  /** Free-form note */
  note?: string;
  /** When true (password auth only), saved password is ignored; user is
   *  prompted on every connect. Stored password is left as-is so toggling
   *  back doesn't lose what they typed. */
  alwaysAskPassword?: boolean;
  /** Route this host's connection through the built-in VPN transport. */
  useVpn?: boolean;
  /** Local VPN profile id (see vpn.ts). The sub URL itself stays local, never
   *  in this record, so it doesn't ride the sync. */
  vpnProfileId?: string;
  /** Chosen exit node tag, or "auto". */
  vpnExit?: string;
}

const STORE_FILE = "hosts.json";
const HOSTS_KEY = "hosts";

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { defaults: {}, autoSave: true });
  }
  return storePromise;
}

export async function listHosts(): Promise<HostRecord[]> {
  const s = await getStore();
  const v = await s.get<HostRecord[]>(HOSTS_KEY);
  return v ?? [];
}

async function maybePushSync() {
  try {
    const s = await syncStatus();
    if (s.configured && s.unlocked) {
      await syncPush();
    }
  } catch {
    /* silent — sync errors should not block local CRUD */
  }
}

/** Fire a window event so subscribers (Sidebar, TabPicker, future SFTP
 *  browser) can refresh after any host-list mutation. Cheap pub-sub
 *  without pulling in a global store. */
const HOSTS_CHANGED_EVENT = "nexussh:hosts-changed";
function notifyHostsChanged() {
  window.dispatchEvent(new CustomEvent(HOSTS_CHANGED_EVENT));
}

export function onHostsChanged(cb: () => void): () => void {
  window.addEventListener(HOSTS_CHANGED_EVENT, cb);
  return () => window.removeEventListener(HOSTS_CHANGED_EVENT, cb);
}

export async function saveHost(rec: HostRecord): Promise<void> {
  const s = await getStore();
  const all = (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
  const idx = all.findIndex((h) => h.id === rec.id);
  if (idx >= 0) all[idx] = rec;
  else all.push(rec);
  await s.set(HOSTS_KEY, all);
  await s.save();
  notifyHostsChanged();
  maybePushSync();
}

export async function deleteHost(id: string): Promise<void> {
  const s = await getStore();
  const all = (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
  const next = all.filter((h) => h.id !== id);
  await s.set(HOSTS_KEY, next);
  await s.save();
  notifyHostsChanged();
  maybePushSync();
}

export async function bumpLastUsed(id: string): Promise<void> {
  const s = await getStore();
  const all = (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
  const h = all.find((x) => x.id === id);
  if (!h) return;
  h.lastUsedAt = new Date().toISOString();
  await s.set(HOSTS_KEY, all);
  await s.save();
}

export function newHostId(): string {
  // Simple UUIDv4 without external dep
  return "h-" + crypto.randomUUID();
}

/**
 * Rename a folder — path-aware. `group` is a "/"-separated path, so renaming
 * "Work/Office-A" must also re-prefix every descendant ("Work/Office-A/Sw" →
 * "Work/Office-B/Sw"). Exact match and prefix match are both rewritten.
 */
export async function renameFolder(
  oldName: string,
  newName: string,
): Promise<void> {
  const all = await listHosts();
  const touched: HostRecord[] = [];
  const prefix = oldName + "/";
  for (const h of all) {
    if (h.group === oldName) {
      h.group = newName;
      touched.push(h);
    } else if (h.group && h.group.startsWith(prefix)) {
      h.group = newName + "/" + h.group.slice(prefix.length);
      touched.push(h);
    }
  }
  for (const h of touched) await saveHost(h);
}

/**
 * Delete a folder — ungroups the folder AND its whole subtree. Does not delete
 * hosts. Path-aware: removes the folder plus every descendant path.
 */
export async function deleteFolder(name: string): Promise<void> {
  const all = await listHosts();
  const touched: HostRecord[] = [];
  const prefix = name + "/";
  for (const h of all) {
    if (h.group === name || (h.group && h.group.startsWith(prefix))) {
      h.group = undefined;
      touched.push(h);
    }
  }
  for (const h of touched) await saveHost(h);
}

/** Move a single host into a folder. Pass null to ungroup. */
export async function moveHostToFolder(
  hostId: string,
  folder: string | null,
): Promise<void> {
  const all = await listHosts();
  const h = all.find((x) => x.id === hostId);
  if (!h) return;
  h.group = folder ?? undefined;
  await saveHost(h);
}

// --- Empty folders ---------------------------------------------------------
// Folders are normally derived from `host.group`, but the user may want to
// create a folder BEFORE adding any hosts to it. We persist a list of "known"
// folder names in localStorage and union it with the derived list at render.

const KNOWN_FOLDERS_LS = "nexussh.knownFolders";

export function loadKnownFolders(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_FOLDERS_LS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function addKnownFolder(name: string) {
  const n = name.trim();
  if (!n) return;
  const list = loadKnownFolders();
  if (!list.includes(n)) {
    list.push(n);
    localStorage.setItem(KNOWN_FOLDERS_LS, JSON.stringify(list));
  }
}

export function removeKnownFolder(name: string) {
  const prefix = name + "/";
  const list = loadKnownFolders().filter(
    (f) => f !== name && !f.startsWith(prefix),
  );
  localStorage.setItem(KNOWN_FOLDERS_LS, JSON.stringify(list));
}

export function renameKnownFolder(oldName: string, newName: string) {
  const prefix = oldName + "/";
  const list = loadKnownFolders().map((f) =>
    f === oldName
      ? newName
      : f.startsWith(prefix)
        ? newName + "/" + f.slice(prefix.length)
        : f,
  );
  localStorage.setItem(KNOWN_FOLDERS_LS, JSON.stringify(list));
}
