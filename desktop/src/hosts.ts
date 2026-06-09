// Host-record CRUD backed by Tauri Store (JSON file in app data dir).
// File path: %APPDATA%/org.hipogas.nexussh/hosts.json on Windows,
//            ~/.local/share/org.hipogas.nexussh/hosts.json on Linux/Mac.
//
// Schema is intentionally simple — sync layer in Phase 5 will wrap this with
// AES-256-GCM encryption before writing to the user-chosen sync folder.

import { load, Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { syncStatus, syncPush } from "./sync";
import { vaultGet, vaultSet, vaultDelete, vaultStatus, vaultKeys } from "./vault";

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
  /** Manual position within its folder (set by drag-reorder). Only consulted in
   *  the "manual" sidebar sort mode; lower comes first. */
  order?: number;
  /** Free-form note */
  note?: string;
  /** When true (password auth only), saved password is ignored; user is
   *  prompted on every connect. Stored password is left as-is so toggling
   *  back doesn't lose what they typed. */
  alwaysAskPassword?: boolean;
  /** Route this host's connection through the built-in VPN transport. */
  useVpn?: boolean;
  /** Opt-in to weak legacy SSH algorithms (3DES/CBC/SHA-1, ssh-rsa) for old
   *  gear (Cisco IOS / ESXi). OFF by default — modern hosts never get the
   *  downgradeable algorithm set. */
  allowLegacy?: boolean;
  /** Local VPN profile id (see vpn.ts). The sub URL itself stays local, never
   *  in this record, so it doesn't ride the sync. */
  vpnProfileId?: string;
  /** Chosen exit node tag, or "auto". */
  vpnExit?: string;
  /** Per-host session-history override. `undefined` = inherit the global on/off
   *  + mode; `"off"` = never record; `"light"`/`"full"` = force-record this host
   *  in that mode regardless of the global mode. (`boolean` kept for back-compat
   *  with v1.8.1 data: `true`→record w/ global mode, `false`→off.) */
  recordHistory?: boolean | "off" | "light" | "full";
}

const STORE_FILE = "hosts.json";
const HOSTS_KEY = "hosts";

// When the user opts in (Security settings), the whole host list — IPs,
// usernames, folder structure — is moved out of plaintext hosts.json and into
// the age-encrypted vault under this single reserved key. The flag lives in
// localStorage so we know WHERE to read from before the vault is unlocked.
const HOSTS_ENCRYPTED_LS = "nexussh.hostsEncrypted";
const VAULT_HOSTLIST_KEY = "__hostlist__";

export function hostsEncrypted(): boolean {
  return localStorage.getItem(HOSTS_ENCRYPTED_LS) === "1";
}

/** Clear the encryption flag — used after a vault reset, when the encrypted
 *  host list is gone and reads must fall back to the (empty) plaintext store. */
export function clearHostsEncryptedFlag(): void {
  localStorage.removeItem(HOSTS_ENCRYPTED_LS);
}

/** Once a vault exists, ALL host data (addresses, logins, passwords) lives in
 *  it — there is no separate user toggle. Call after every unlock/create/
 *  restore: if the unlocked vault already holds the host list, route reads to
 *  it; if it doesn't yet (a vault that predates this, or a freshly created
 *  one), migrate the plaintext list in now. Fires a refresh so the sidebar
 *  reloads from the right source. */
export async function ensureHostsInVault(): Promise<void> {
  try {
    const st = await vaultStatus();
    if (!st.unlocked) {
      notifyHostsChanged();
      return;
    }
    const keys = await vaultKeys();
    if (keys.includes(VAULT_HOSTLIST_KEY)) {
      localStorage.setItem(HOSTS_ENCRYPTED_LS, "1");
    } else {
      // Vault exists but the list isn't in it yet — move it in (clear the flag
      // first so enableHostEncryption doesn't early-return on a stale value).
      localStorage.removeItem(HOSTS_ENCRYPTED_LS);
      await enableHostEncryption();
    }
  } catch {
    /* vault locked or unreadable — leave reads as-is */
  }
  notifyHostsChanged();
}

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { defaults: {}, autoSave: true });
  }
  return storePromise;
}

// --- Storage source switch -------------------------------------------------
// Every host read/write goes through readAll/writeAll, which route to either
// the plaintext store or the encrypted vault based on the opt-in flag. This
// keeps all the CRUD helpers below source-agnostic.

// Where the host list lives is decided by the VAULT's own state in Rust, which
// is shared across every window — NOT by the per-window localStorage flag. A
// localStorage flag diverges between windows (and even survives a restart in a
// stale state), which made edits in one window invisible to another. The vault
// file existing on disk is the single, global source of truth: once a vault
// exists, the host list belongs in it; until it exists, plaintext hosts.json.
async function vaultSource(): Promise<{ inVault: boolean; unlocked: boolean }> {
  try {
    const st = await vaultStatus();
    return { inVault: st.configured, unlocked: st.unlocked };
  } catch {
    return { inVault: false, unlocked: false };
  }
}

async function readAll(): Promise<HostRecord[]> {
  const { inVault, unlocked } = await vaultSource();
  if (inVault) {
    // Vault exists → it owns the list. Locked: show empty until unlock.
    if (!unlocked) return [];
    try {
      const raw = await vaultGet(VAULT_HOSTLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      /* key not migrated into the vault yet — fall through to plaintext */
    }
    // Vault unlocked but the list hasn't been moved in yet (vault created for
    // passwords only). Read the plaintext copy; the next write migrates it in.
    const s = await getStore();
    return (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
  }
  const s = await getStore();
  return (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
}

async function writeAll(all: HostRecord[]): Promise<void> {
  const { inVault, unlocked } = await vaultSource();
  if (inVault) {
    if (!unlocked) {
      // Refuse to fork a divergent plaintext copy while the vault is locked.
      throw new Error("vault locked");
    }
    await vaultSet(VAULT_HOSTLIST_KEY, JSON.stringify(all));
    // Keep the legacy flag in sync for any code still reading it.
    localStorage.setItem(HOSTS_ENCRYPTED_LS, "1");
    return;
  }
  const s = await getStore();
  await s.set(HOSTS_KEY, all);
  await s.save();
}

export async function listHosts(): Promise<HostRecord[]> {
  return await readAll();
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

/** Fire an event so subscribers (Sidebar, TabPicker, …) re-read after any
 *  host-list mutation. Two channels:
 *   - a same-window DOM CustomEvent (instant, no IPC), and
 *   - a Tauri app event that crosses to OTHER windows, so a second window
 *     editing hosts is reflected live in this one (the store itself is shared
 *     in Rust; the other window just needs the nudge to re-read).
 */
const HOSTS_CHANGED_EVENT = "nexussh:hosts-changed";
const HAS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function notifyHostsChanged() {
  window.dispatchEvent(new CustomEvent(HOSTS_CHANGED_EVENT));
  if (HAS_TAURI) {
    import("@tauri-apps/api/event")
      .then(({ emit }) => emit(HOSTS_CHANGED_EVENT))
      .catch(() => {});
  }
}

export function onHostsChanged(cb: () => void): () => void {
  window.addEventListener(HOSTS_CHANGED_EVENT, cb);
  let unlistenTauri: (() => void) | null = null;
  let disposed = false;
  if (HAS_TAURI) {
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen(HOSTS_CHANGED_EVENT, () => cb()).then((un) => {
          if (disposed) un();
          else unlistenTauri = un;
        }),
      )
      .catch(() => {});
  }
  return () => {
    disposed = true;
    window.removeEventListener(HOSTS_CHANGED_EVENT, cb);
    if (unlistenTauri) unlistenTauri();
  };
}

/** Public trigger — used after a vault unlock so subscribers re-read hosts
 *  that were unavailable (empty) while the encrypted list was locked. */
export function refreshHosts() {
  notifyHostsChanged();
}

export async function saveHost(rec: HostRecord): Promise<void> {
  const all = await readAll();
  const idx = all.findIndex((h) => h.id === rec.id);
  if (idx >= 0) all[idx] = rec;
  else all.push(rec);
  await writeAll(all);
  notifyHostsChanged();
  maybePushSync();
}

export async function deleteHost(id: string): Promise<void> {
  const all = await readAll();
  const next = all.filter((h) => h.id !== id);
  await writeAll(next);
  notifyHostsChanged();
  maybePushSync();
}

export async function bumpLastUsed(id: string): Promise<void> {
  const all = await readAll();
  const h = all.find((x) => x.id === id);
  if (!h) return;
  h.lastUsedAt = new Date().toISOString();
  await writeAll(all);
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

/** Delete a folder AND every host inside it (and its whole subtree), in one
 *  batched write. The other deleteFolder ungroups; this one removes the hosts. */
export async function deleteFolderWithHosts(name: string): Promise<void> {
  const all = await readAll();
  const prefix = name + "/";
  const next = all.filter(
    (h) => !(h.group === name || (h.group && h.group.startsWith(prefix))),
  );
  await writeAll(next);
  removeKnownFolder(name);
  notifyHostsChanged();
  maybePushSync();
}

/** Wipe EVERY host and every remembered (empty) folder. One write. */
export async function deleteAllHosts(): Promise<void> {
  await writeAll([]);
  clearKnownFolders();
  notifyHostsChanged();
  maybePushSync();
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

/** Assign `order` = position to each listed id (and set their group), in one
 *  batched write. Used by sidebar drag-reorder so the manual sort sticks. */
export async function reorderHosts(
  orderedIds: string[],
  folder: string | null,
): Promise<void> {
  const all = await readAll();
  orderedIds.forEach((id, i) => {
    const h = all.find((x) => x.id === id);
    if (h) {
      h.order = i;
      h.group = folder ?? undefined;
    }
  });
  await writeAll(all);
  notifyHostsChanged();
  maybePushSync();
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

/** Wipe all remembered (empty) folders — used on vault reset so the tree is a
 *  clean slate, not a list of folders with no hosts in them. */
export function clearKnownFolders() {
  localStorage.removeItem(KNOWN_FOLDERS_LS);
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

// --- Host-list encryption migration ----------------------------------------
// Move the whole list between plaintext store and encrypted vault. Both
// directions require the vault to be UNLOCKED (caller guarantees it). On
// failure the source is left intact — the flag is flipped only after the new
// location holds the data, so a crash mid-migration can't lose hosts.

/** Move host list from plaintext hosts.json into the encrypted vault. Requires
 *  an unlocked vault (caller guarantees). Ordered for durability: the encrypted
 *  copy exists before the flag flips, and the flag flips before the plaintext
 *  is scrubbed — so at no intermediate point is the list readable from neither
 *  source. If the scrub throws, `reconcileHostEncryption()` cleans up at next
 *  start (no data loss — the flag already routes reads to the vault). */
export async function enableHostEncryption(): Promise<void> {
  if (hostsEncrypted()) return;
  const s = await getStore();
  const all = (await s.get<HostRecord[]>(HOSTS_KEY)) ?? [];
  await vaultSet(VAULT_HOSTLIST_KEY, JSON.stringify(all)); // 1. encrypted copy
  localStorage.setItem(HOSTS_ENCRYPTED_LS, "1"); //            2. reads → vault
  await s.delete(HOSTS_KEY); //                                3. scrub plaintext
  await s.save();
  // Move the host-key pins into the vault too, so connected-host addresses
  // don't linger in plaintext known_hosts.json.
  await invoke("known_hosts_to_vault").catch(() => {});
  notifyHostsChanged();
}

/** If the list is encrypted but a plaintext copy lingers in hosts.json (e.g. a
 *  crash mid-enable), scrub it. Call once at startup. */
export async function reconcileHostEncryption(): Promise<void> {
  if (!hostsEncrypted()) return;
  try {
    const s = await getStore();
    const leftover = await s.get<HostRecord[]>(HOSTS_KEY);
    if (leftover && leftover.length) {
      await s.delete(HOSTS_KEY);
      await s.save();
    }
    // Also fold any plaintext known_hosts.json into the vault (idempotent).
    await invoke("known_hosts_to_vault").catch(() => {});
  } catch {
    /* best-effort */
  }
}

/** Move host list from the encrypted vault back into plaintext hosts.json. */
export async function disableHostEncryption(): Promise<void> {
  if (!hostsEncrypted()) return;
  // Must be able to read the encrypted list before dropping it. If the vault is
  // locked we cannot — abort rather than lose the list.
  const st = await vaultStatus();
  if (!st.unlocked) throw new Error("vault locked");
  let all: HostRecord[] = [];
  try {
    const raw = await vaultGet(VAULT_HOSTLIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) all = parsed;
    }
  } catch {
    // Unlocked but read threw → the key was never written (empty list). Safe to
    // proceed with an empty plaintext list rather than getting stuck ON forever.
    all = [];
  }
  // Restore host-key pins to the plaintext file before flipping the flag.
  await invoke("known_hosts_from_vault").catch(() => {});
  const s = await getStore();
  await s.set(HOSTS_KEY, all); //               1. write plaintext copy
  await s.save();
  localStorage.removeItem(HOSTS_ENCRYPTED_LS); // 2. flip source flag
  await vaultDelete(VAULT_HOSTLIST_KEY).catch(() => {}); // 3. drop encrypted copy
  notifyHostsChanged();
}
