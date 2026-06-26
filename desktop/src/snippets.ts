// Snippets — saved commands fired into the active SSH terminal with one click
// or a 1–9 hotkey. Stored in localStorage (not secrets). Optional account-sync:
// the list is mirrored into the vault transport blob SNIPPETS_KEY, and the Rust
// engine slices it into PER-SNIPPET `snippet.<id>` items (exactly like hosts) —
// so add/edit/delete sync reliably first-try, no whole-blob LWW races. Each
// snippet carries `updatedAt` (epoch-ms) as the per-item LWW key; deletions are
// explicit per-item tombstones (account_record_snippet_tombstones).

import { invoke } from "@tauri-apps/api/core";
import { vaultGet, vaultSet, vaultDelete } from "./vault";

/** Local transport blob — Rust slices it into snippet.<id> items. Must match
 *  account.rs SNIPPETS_KEY. */
const SNIPPETS_KEY = "nexussh.snippets";

export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Append "\n" so the command executes immediately (↵). */
  autoRun: boolean;
  /** Ask before sending (⚠) — for destructive commands. */
  confirm: boolean;
  /** 1..9, unique across snippets; undefined = no hotkey. */
  hotkey?: number;
  /** Free-form group, e.g. "Linux" / "Cisco" / "Docker". */
  category?: string;
  /** Manual drag-reorder position. */
  order: number;
  /** epoch-ms of the last edit — per-item LWW key (like host updatedAt). */
  updatedAt?: number;
}

const LS = "nexussh.snippets.v1";
const LS_CATS = "nexussh.snippets.categories.v1";
const LS_SYNC = "nexussh.snippets.sync";
const EVT = "nx:snippets-changed";

interface LegacySnippet {
  id: string;
  name: string;
  command: string;
  enter?: boolean;
}

const now = () => Date.now();

function listSnippetsRaw(): Snippet[] {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return [];
    const arr = JSON.parse(raw) as (Snippet | LegacySnippet)[];
    if (!Array.isArray(arr)) return [];
    // Migrate legacy {enter} → {autoRun, confirm, order}; drop stale soft-delete
    // tombstones from the old blob scheme (_deleted) — deletions are per-item now.
    return arr
      .filter((s) => s && s.id && !(s as { _deleted?: boolean })._deleted)
      .map((s, i) => ({
        id: s.id,
        name: s.name,
        command: s.command,
        autoRun: "autoRun" in s ? !!s.autoRun : !!(s as LegacySnippet).enter,
        confirm: "confirm" in s ? !!s.confirm : false,
        hotkey: "hotkey" in s ? (s as Snippet).hotkey : undefined,
        category: "category" in s ? (s as Snippet).category : undefined,
        order: "order" in s && typeof (s as Snippet).order === "number" ? (s as Snippet).order : i,
        updatedAt: "updatedAt" in s ? (s as Snippet).updatedAt : undefined,
      }));
  } catch {
    return [];
  }
}

/** Active snippets, ordered — for UI + callers. */
export function listSnippets(): Snippet[] {
  return listSnippetsRaw().sort((a, b) => a.order - b.order);
}

function persist(all: Snippet[]) {
  // Re-pack order contiguously, write back, mirror into the vault transport blob.
  const packed = all
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ ...s, order: i }));
  localStorage.setItem(LS, JSON.stringify(packed));
  window.dispatchEvent(new Event(EVT));
  if (snippetsSyncEnabled()) void mirrorToVault(packed);
}

/** Mirror the full list into the vault transport blob. The Rust engine reads it
 *  and pushes each snippet as its own snippet.<id> item (LWW by updatedAt). */
async function mirrorToVault(all: Snippet[]) {
  try {
    await vaultSet(SNIPPETS_KEY, JSON.stringify(all));
  } catch {
    /* vault locked / not logged in — next unlock+sync picks it up */
  }
}

export function addSnippet(s: Omit<Snippet, "id" | "order">): Snippet {
  const all = listSnippets();
  const ns: Snippet = { ...s, id: crypto.randomUUID(), order: all.length, updatedAt: now() };
  // Hotkey steal: clear the digit on any other snippet that held it (bump its ts
  // too, so the change syncs).
  const cleaned = ns.hotkey
    ? all.map((x) => (x.hotkey === ns.hotkey ? { ...x, hotkey: undefined, updatedAt: now() } : x))
    : all;
  persist([...cleaned, ns]);
  return ns;
}

export function updateSnippet(s: Snippet) {
  const all = listSnippets();
  const next = all.map((x) => {
    if (x.id === s.id) return { ...s, updatedAt: now() };
    // Hotkey steal from others.
    if (s.hotkey && x.hotkey === s.hotkey) return { ...x, hotkey: undefined, updatedAt: now() };
    return x;
  });
  persist(next);
}

export function deleteSnippet(id: string) {
  // Hard delete locally + explicit per-item tombstone so the deletion propagates
  // to other devices (mirrors how host deletion works — never inferred).
  persist(listSnippets().filter((x) => x.id !== id));
  if (snippetsSyncEnabled()) {
    invoke("account_record_snippet_tombstones", { ids: [id] }).catch(() => {});
  }
}

/** Reorder: move snippets into `orderedIds` order; bump updatedAt so the new
 *  positions sync per-item. */
export function reorderSnippets(orderedIds: string[]) {
  const byId = new Map(listSnippets().map((s) => [s.id, s]));
  const next = orderedIds
    .map((id, i) => {
      const s = byId.get(id);
      return s ? { ...s, order: i, updatedAt: now() } : null;
    })
    .filter(Boolean) as Snippet[];
  persist(next);
}

// --- categories (user-created, may be empty) -------------------------------
export function listCategories(): string[] {
  const fromSnips = new Set(listSnippets().map((s) => s.category).filter(Boolean) as string[]);
  let explicit: string[] = [];
  try {
    explicit = JSON.parse(localStorage.getItem(LS_CATS) || "[]");
    if (!Array.isArray(explicit)) explicit = [];
  } catch {
    explicit = [];
  }
  for (const c of explicit) fromSnips.add(c);
  return Array.from(fromSnips).sort((a, b) => a.localeCompare(b));
}

export function addCategory(name: string) {
  const n = name.trim();
  if (!n) return;
  const cur = listCategories();
  if (cur.includes(n)) return;
  try {
    const explicit = JSON.parse(localStorage.getItem(LS_CATS) || "[]");
    localStorage.setItem(LS_CATS, JSON.stringify([...(Array.isArray(explicit) ? explicit : []), n]));
  } catch {
    localStorage.setItem(LS_CATS, JSON.stringify([n]));
  }
  window.dispatchEvent(new Event(EVT));
}

/** Remove a category: drop it from the explicit list AND clear it off any snippet. */
export function removeCategory(name: string) {
  try {
    const explicit = JSON.parse(localStorage.getItem(LS_CATS) || "[]");
    if (Array.isArray(explicit)) {
      localStorage.setItem(LS_CATS, JSON.stringify(explicit.filter((c: string) => c !== name)));
    }
  } catch {
    /* ignore */
  }
  const cleared = listSnippets().map((s) =>
    s.category === name ? { ...s, category: undefined, updatedAt: now() } : s,
  );
  persist(cleared); // persists + dispatches EVT (+ mirrors to vault when synced)
}

// --- per-device sync toggle ------------------------------------------------
export function snippetsSyncEnabled(): boolean {
  return localStorage.getItem(LS_SYNC) === "1";
}
export function setSnippetsSyncEnabled(on: boolean) {
  localStorage.setItem(LS_SYNC, on ? "1" : "0");
  if (on) {
    void mirrorToVault(listSnippets());
  } else {
    // Sync OFF → explicit per-item tombstones for every snippet (so they leave
    // the server) + drop the local transport blob. Explicit-only, never inferred.
    const ids = listSnippets().map((s) => s.id);
    if (ids.length) invoke("account_record_snippet_tombstones", { ids }).catch(() => {});
    vaultDelete(SNIPPETS_KEY).catch(() => {});
  }
  window.dispatchEvent(new Event(EVT));
}

/** After an account sync, read the reconstructed transport blob (the Rust engine
 *  merged the per-snippet items into it) back into localStorage. */
export async function pullSnippetsToLocal(): Promise<boolean> {
  if (!snippetsSyncEnabled()) return false;
  try {
    const raw = await vaultGet(SNIPPETS_KEY);
    if (!raw) return false;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return false;
    const before = localStorage.getItem(LS);
    const str = JSON.stringify(arr);
    localStorage.setItem(LS, str);
    window.dispatchEvent(new Event(EVT));
    return str !== before;
  } catch {
    return false;
  }
}

/** Mirror the current list into the vault transport blob, awaited — call right
 *  before a sync so the push carries the latest snippets. */
export async function pushSnippetsToVault() {
  if (!snippetsSyncEnabled()) return;
  await mirrorToVault(listSnippets());
}

// --- import / export -------------------------------------------------------
/** Export JSON array (strip id/order/updatedAt — regenerated on import). */
export function exportSnippets(): string {
  const list = listSnippets().map(({ id: _id, order: _order, updatedAt: _u, ...rest }) => rest);
  return JSON.stringify(list, null, 2);
}

/** Import: merge, dedupe by (name+command). Returns {added, skipped}. */
export function importSnippets(json: string): { added: number; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { added: 0, skipped: 0 };
  }
  if (!Array.isArray(parsed)) return { added: 0, skipped: 0 };
  const existing = listSnippets();
  const seen = new Set(existing.map((s) => `${s.name} ${s.command}`));
  let added = 0;
  let skipped = 0;
  let order = existing.length;
  const toAdd: Snippet[] = [];
  for (const raw of parsed as Partial<Snippet>[]) {
    if (!raw || typeof raw.name !== "string" || typeof raw.command !== "string") {
      skipped++;
      continue;
    }
    const key = `${raw.name} ${raw.command}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    toAdd.push({
      id: crypto.randomUUID(),
      name: raw.name,
      command: raw.command,
      autoRun: !!raw.autoRun,
      confirm: !!raw.confirm,
      hotkey: undefined, // don't import hotkeys — avoid clashes
      category: typeof raw.category === "string" ? raw.category : undefined,
      order: order++,
      updatedAt: now(),
    });
    added++;
  }
  if (toAdd.length) persist([...existing, ...toAdd]);
  return { added, skipped };
}

/** Substitute {{host}} {{user}} {{port}} from the active session before send. */
export function expandPlaceholders(
  command: string,
  ctx: { host?: string; user?: string; port?: number } | null,
): string {
  if (!ctx) return command;
  return command
    .replace(/\{\{host\}\}/g, ctx.host ?? "")
    .replace(/\{\{user\}\}/g, ctx.user ?? "")
    .replace(/\{\{port\}\}/g, ctx.port != null ? String(ctx.port) : "");
}

/** Subscribe to snippet-list changes (add/edit/delete/reorder). */
export function onSnippetsChanged(cb: () => void): () => void {
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}
