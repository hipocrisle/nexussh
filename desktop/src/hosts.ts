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

export async function saveHost(rec: HostRecord): Promise<void> {
  const s = await getStore();
  const all = (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
  const idx = all.findIndex((h) => h.id === rec.id);
  if (idx >= 0) all[idx] = rec;
  else all.push(rec);
  await s.set(HOSTS_KEY, all);
  await s.save();
  maybePushSync();
}

export async function deleteHost(id: string): Promise<void> {
  const s = await getStore();
  const all = (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
  const next = all.filter((h) => h.id !== id);
  await s.set(HOSTS_KEY, next);
  await s.save();
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

/** Rename a folder — updates `group` field of every host that was in it. */
export async function renameFolder(
  oldName: string,
  newName: string,
): Promise<void> {
  const all = await listHosts();
  const touched: HostRecord[] = [];
  for (const h of all) {
    if (h.group === oldName) {
      h.group = newName;
      touched.push(h);
    }
  }
  for (const h of touched) await saveHost(h);
}

/** Delete a folder — moves its hosts to "ungrouped". Does not delete hosts. */
export async function deleteFolder(name: string): Promise<void> {
  const all = await listHosts();
  const touched: HostRecord[] = [];
  for (const h of all) {
    if (h.group === name) {
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
