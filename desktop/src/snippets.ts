// Snippets — saved commands fired into the active SSH terminal with one click
// or a 1–9 hotkey. Stored in localStorage (not secrets). Optional account-sync
// rides the same encrypted channel as hosts when the per-device toggle is on:
// the whole list is mirrored into vault key SNIPPETS_KEY (one blob), which the
// Rust sync engine pushes/pulls; on pull we read the blob back into localStorage.

import { invoke } from "@tauri-apps/api/core";
import { vaultGet, vaultSet, vaultDelete } from "./vault";

/** Must match account.rs SNIPPETS_KEY (the global synced blob item). */
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

export function listSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return [];
    const arr = JSON.parse(raw) as (Snippet | LegacySnippet)[];
    if (!Array.isArray(arr)) return [];
    // Migrate legacy {enter} → {autoRun, confirm, order}.
    const migrated: Snippet[] = arr.map((s, i) => ({
      id: s.id,
      name: s.name,
      command: s.command,
      autoRun: "autoRun" in s ? !!s.autoRun : !!(s as LegacySnippet).enter,
      confirm: "confirm" in s ? !!s.confirm : false,
      hotkey: "hotkey" in s ? (s as Snippet).hotkey : undefined,
      category: "category" in s ? (s as Snippet).category : undefined,
      order: "order" in s && typeof (s as Snippet).order === "number" ? (s as Snippet).order : i,
    }));
    return migrated.sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

function persist(all: Snippet[]) {
  // Re-pack order to be contiguous.
  const packed = all
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ ...s, order: i }));
  localStorage.setItem(LS, JSON.stringify(packed));
  window.dispatchEvent(new Event(EVT));
  if (snippetsSyncEnabled()) void mirrorToVault(packed);
}

/** Mirror the full list into the synced vault blob + mark it dirty for sync. */
async function mirrorToVault(all: Snippet[], touch = true) {
  try {
    await vaultSet(SNIPPETS_KEY, JSON.stringify(all));
    // Bump updated_at ONLY on a real edit — NOT on every pre-sync mirror. Else
    // each sync makes THIS device "newest" and LWW clobbers the other side's
    // changes → one-directional sync (Win→Ubuntu ok, Ubuntu→Win lost).
    if (touch) await invoke("account_touch_snippets");
  } catch {
    /* vault locked / not logged in — next unlock+sync picks it up */
  }
}

export function addSnippet(s: Omit<Snippet, "id" | "order">): Snippet {
  const all = listSnippets();
  const ns: Snippet = { ...s, id: crypto.randomUUID(), order: all.length };
  // Hotkey steal: clear the digit on any other snippet that held it.
  const cleaned = ns.hotkey ? all.map((x) => (x.hotkey === ns.hotkey ? { ...x, hotkey: undefined } : x)) : all;
  persist([...cleaned, ns]);
  return ns;
}

export function updateSnippet(s: Snippet) {
  const all = listSnippets();
  const next = all.map((x) => {
    if (x.id === s.id) return s;
    // Hotkey steal from others.
    if (s.hotkey && x.hotkey === s.hotkey) return { ...x, hotkey: undefined };
    return x;
  });
  persist(next);
}

export function deleteSnippet(id: string) {
  persist(listSnippets().filter((x) => x.id !== id));
}

/** Reorder: move snippet `id` to sit at `targetIndex` in the visible order. */
export function reorderSnippets(orderedIds: string[]) {
  const byId = new Map(listSnippets().map((s) => [s.id, s]));
  const next = orderedIds
    .map((id, i) => {
      const s = byId.get(id);
      return s ? { ...s, order: i } : null;
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
    s.category === name ? { ...s, category: undefined } : s,
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
    // explicit tombstone (never inferred) + drop the local blob copy
    invoke("account_tombstone_snippets").catch(() => {});
    vaultDelete(SNIPPETS_KEY).catch(() => {});
  }
  window.dispatchEvent(new Event(EVT));
}

/** After an account sync, read the pulled blob back into localStorage. */
export async function pullSnippetsToLocal() {
  if (!snippetsSyncEnabled()) return;
  try {
    const raw = await vaultGet(SNIPPETS_KEY);
    if (!raw) return;
    const remote = JSON.parse(raw);
    if (!Array.isArray(remote) || remote.length === 0) return;
    // Merge by id — remote wins on conflict, but local-only snippets are KEPT.
    // Never silently drop what the user added locally just because the synced
    // blob is stale (this caused "export shows only the first 3" data-loss).
    const byId = new Map<string, Snippet>();
    for (const s of listSnippets()) byId.set(s.id, s);
    for (const r of remote as Snippet[]) if (r?.id) byId.set(r.id, r);
    const merged = Array.from(byId.values()).map((s, i) => ({
      ...s,
      order: typeof s.order === "number" ? s.order : i,
    }));
    localStorage.setItem(LS, JSON.stringify(merged));
    window.dispatchEvent(new Event(EVT));
  } catch {
    /* vault locked or key absent — nothing to pull */
  }
}

/** Mirror the CURRENT list into the vault blob + touch, awaited — call right
 *  before a sync so the push always carries the latest snippets. Fixes the
 *  async-mirror race (persist's mirror is fire-and-forget) that let a sync push
 *  a stale list → device drift. */
export async function pushSnippetsToVault() {
  if (!snippetsSyncEnabled()) return;
  // No touch: just make sure the vault blob holds the current list. The
  // updated_at reflects the last real EDIT, so LWW stays correct both ways.
  await mirrorToVault(listSnippets(), false);
}

// --- import / export -------------------------------------------------------
/** Export JSON array (strip id/order — regenerated on import). */
export function exportSnippets(): string {
  const list = listSnippets().map(({ id: _id, order: _order, ...rest }) => rest);
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
  const seen = new Set(existing.map((s) => `${s.name} ${s.command}`));
  let added = 0;
  let skipped = 0;
  let order = existing.length;
  const toAdd: Snippet[] = [];
  for (const raw of parsed as Partial<Snippet>[]) {
    if (!raw || typeof raw.name !== "string" || typeof raw.command !== "string") {
      skipped++;
      continue;
    }
    const key = `${raw.name} ${raw.command}`;
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
