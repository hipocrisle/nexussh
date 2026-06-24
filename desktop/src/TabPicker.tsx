// TabPicker — compact host quick-picker shown when user clicks `+` in TabBar
// or hits Ctrl+T. Keyboard-driven: type to filter, Up/Down to move, Enter to open.
//
// Two modes:
//   * Empty search box → render the SAME folder tree as Sidebar (collapsible
//     "/" - separated groups). Without tree, the picker becomes useless once
//     you have >50 hosts.
//   * Non-empty search box → flat results (faster scanning while typing).
//
// Also: a "+ New connection" button at the top so users don't have to leave
// the picker to create a host.

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Server, ChevronRight, ChevronDown, Folder, Plus, X, Zap,
  Loader2, Check, AlertTriangle } from "lucide-react";
import { HostRecord, listHosts } from "./hosts";
import { tcpPing } from "./ssh";
import { Input, PasswordInput, Button, Checkbox } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";
import { POPOVER_SURFACE, PopoverDivider } from "./Popover";

interface Props {
  onPick: (h: HostRecord) => void;
  onCreateNew?: () => void;
  /** Quick connect after the in-card reachability check + creds: open host:port
   *  with the given login/password (saved as a host when `save`). */
  onQuickConnect?: (host: string, port: number, save: boolean, user: string, password: string) => void;
  onClose: () => void;
}

type Target = { host: string; port: number };
type QuickState =
  | { kind: "idle" }
  | { kind: "ready" }
  | { kind: "checking"; target: Target }
  | { kind: "creds"; target: Target; latencyMs: number }
  | { kind: "error"; target: Target; reason: string };

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[rgba(0,255,149,0.18)] text-nx-accent px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

interface FolderNode {
  path: string;
  name: string;
  children: Map<string, FolderNode>;
  hosts: HostRecord[];
}

function buildTree(hosts: HostRecord[]): FolderNode {
  const root: FolderNode = { path: "", name: "", children: new Map(), hosts: [] };
  const ensure = (path: string): FolderNode => {
    if (!path) return root;
    const parts = path.split("/").filter(Boolean);
    let node = root;
    let accum = "";
    for (const p of parts) {
      accum = accum ? `${accum}/${p}` : p;
      let child = node.children.get(p);
      if (!child) {
        child = { path: accum, name: p, children: new Map(), hosts: [] };
        node.children.set(p, child);
      }
      node = child;
    }
    return node;
  };
  for (const h of hosts) {
    if (h.group) ensure(h.group).hosts.push(h);
    else root.hosts.push(h);
  }
  return root;
}

function sortedChildren(n: FolderNode): FolderNode[] {
  return Array.from(n.children.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Total hosts in a folder's whole subtree (direct + nested), to match the
 *  sidebar's count. The badge previously showed direct-hosts + subfolder-count,
 *  which is wrong for folders that nest their hosts. */
function countSubtreeHosts(n: FolderNode): number {
  let total = n.hosts.length;
  for (const child of n.children.values()) total += countSubtreeHosts(child);
  return total;
}

// Flatten tree to a list of visible items respecting `expanded`. Items are
// either folders (depth marker) or hosts (depth marker). Used for keyboard
// navigation indexing.
type Row =
  | { kind: "folder"; node: FolderNode; depth: number }
  | { kind: "host"; host: HostRecord; depth: number };

function flatten(root: FolderNode, expanded: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (node: FolderNode, depth: number) => {
    for (const child of sortedChildren(node)) {
      out.push({ kind: "folder", node: child, depth });
      if (expanded.has(child.path)) {
        walk(child, depth + 1);
        for (const h of [...child.hosts].sort((a, b) => a.name.localeCompare(b.name))) {
          out.push({ kind: "host", host: h, depth: depth + 1 });
        }
      }
    }
    if (node === root) {
      // root-level hosts (no group) appear at depth 0 below folders
      for (const h of [...node.hosts].sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ kind: "host", host: h, depth: 0 });
      }
    }
  };
  walk(root, 0);
  return out;
}

const EXPANDED_LS_KEY = "nexussh.tabPickerExpanded";

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_LS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function persistExpanded(s: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_LS_KEY, JSON.stringify([...s]));
  } catch {}
}

/** Contextual quick-connect card with the reachability flow (step 11).
 *  ready → (Enter) checking → reachable=creds / unreachable=error. */
function QuickConnectCard({
  state, port, onPort, save, onSave, login, onLogin, password, onPassword,
  onRun, onFinish, onCancel,
}: {
  state: QuickState;
  port: string; onPort: (v: string) => void;
  save: boolean; onSave: (v: boolean) => void;
  login: string; onLogin: (v: string) => void;
  password: string; onPassword: (v: string) => void;
  onRun: () => void; onFinish: () => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const target = "target" in state ? state.target : null;
  const addr = target ? `${target.host}:${target.port}` : "";
  const wrap =
    state.kind === "error" ? "border-nx-error"
    : state.kind === "checking" ? "border-nx-warning"
    : "border-nx-accent";

  return (
    <div
      className={"rounded-[7px] p-3.5 border " + wrap}
      style={{
        background: "linear-gradient(180deg, rgba(0,255,149,0.06), transparent)",
        boxShadow: "0 0 24px var(--nx-accent-glow)",
      }}
    >
      {state.kind === "ready" && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Zap size={13} className="text-nx-accent shrink-0" />
            <span className="text-micro uppercase tracking-wider text-nx-accent">
              {t("connect.quick_kicker")}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <label className="text-meta text-nx-muted">{t("connect.port")}</label>
              <input
                value={port}
                onChange={(e) => onPort(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onRun(); e.stopPropagation(); }}
                inputMode="numeric"
                aria-label={t("connect.port")}
                className="w-[60px] bg-nx-panel border border-nx-border rounded-nx px-2 py-1 text-nx-text font-mono text-body text-center outline-none focus:border-nx-accent"
              />
              <Button type="button" variant="primary" size="sm" onClick={onRun}>
                {t("connect.connect_btn")} ↵
              </Button>
            </div>
          </div>
          <p className="text-meta text-nx-muted mt-2">{t("connect.quick_hint")}</p>
          <Checkbox checked={save} onChange={onSave} className="mt-3" label={t("connect.save_after")} />
        </>
      )}

      {state.kind === "checking" && (
        <div className="flex items-center gap-2.5">
          <Loader2 size={14} className="text-nx-warning shrink-0 animate-spin" />
          <div className="min-w-0">
            <div className="text-body text-nx-text">{t("connect.checking")}</div>
            <div className="text-meta text-nx-muted font-mono truncate">{addr} — {t("connect.tcp_ping")}</div>
          </div>
          <button type="button" onClick={onCancel} className="ml-auto text-meta text-nx-muted hover:text-nx-text">
            {t("connect.cancel")}
          </button>
        </div>
      )}

      {state.kind === "creds" && (
        <div
          onKeyDown={(e) => {
            // ↵ из любого поля карточки → подключение (Tab проходит login →
            // password → "сохранить хост" → кнопку; Space переключает чекбокс).
            if (e.key === "Enter") {
              e.preventDefault();
              onFinish();
            }
          }}
        >
          <div className="flex items-center gap-2 pb-2.5 mb-2.5 border-b border-nx-divider">
            <Check size={13} className="text-nx-accent shrink-0" />
            <span className="text-body text-nx-text">{t("connect.reachable")}</span>
            <span className="text-meta text-nx-muted font-mono ml-auto truncate">
              {addr} · {state.latencyMs}ms
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input value={login} onChange={onLogin} placeholder={t("connect.login")} autoFocus />
            <PasswordInput value={password} onChange={onPassword} placeholder={t("connect.password")} />
          </div>
          <div className="flex items-center gap-3 mt-3">
            <Checkbox checked={save} onChange={onSave} label={t("connect.save_as_host")} />
            <Button type="button" variant="primary" size="sm" className="ml-auto" onClick={onFinish}>
              {t("connect.connect_btn")}
            </Button>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="flex items-center gap-2.5">
          <AlertTriangle size={14} className="text-nx-error shrink-0" />
          <div className="min-w-0">
            <div className="text-body text-nx-error">{t("connect.unreachable")}</div>
            <div className="text-meta text-nx-muted font-mono truncate">{addr} — {t("connect.timeout", { s: 8 })}</div>
          </div>
          <Button type="button" variant="secondary" size="sm" className="ml-auto" onClick={onRun}>
            {t("connect.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function TabPicker({ onPick, onCreateNew, onQuickConnect, onClose }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [q, setQ] = useState("");
  // Quick-connect state machine (idle→ready→checking→creds/error).
  const [quick, setQuick] = useState<QuickState>({ kind: "idle" });
  const [qcPort, setQcPort] = useState("22");
  const [qcSave, setQcSave] = useState(false);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Surface the quick card whenever the field is non-empty — but don't disturb
  // an in-flight checking/creds/error flow.
  useEffect(() => {
    setQuick((s) =>
      s.kind === "idle" || s.kind === "ready"
        ? { kind: q.trim() ? "ready" : "idle" }
        : s,
    );
  }, [q]);

  async function runQuickConnect() {
    const host = q.trim();
    if (!host) return;
    const n = parseInt(qcPort, 10);
    const port = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 22;
    const target = { host, port };
    setQuick({ kind: "checking", target });
    try {
      const latencyMs = await tcpPing(host, port, 8000);
      setQuick({ kind: "creds", target, latencyMs });
    } catch (e) {
      setQuick({ kind: "error", target, reason: String(e) });
    }
  }

  function finishConnect() {
    if (quick.kind !== "creds" || !onQuickConnect) return;
    const { host, port } = quick.target;
    onQuickConnect(host, port, qcSave, login.trim(), password);
    onClose();
  }
  const listRef = useRef<HTMLDivElement>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);

  useEffect(() => {
    listHosts().then((list) => {
      list.sort((a, b) => {
        const la = a.lastUsedAt ?? "";
        const lb = b.lastUsedAt ?? "";
        if (la !== lb) return la < lb ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      setHosts(list);
      // First-time UX: if no expanded folders saved, expand top-level folders
      // so user immediately sees structure (otherwise tree looks like a wall
      // of collapsed boxes).
      if (loadExpanded().size === 0) {
        const root = buildTree(list);
        const top = new Set<string>();
        for (const child of sortedChildren(root)) top.add(child.path);
        setExpanded(top);
      }
    });
    // Focus the smart search field — it's the single primary input now.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      persistExpanded(next);
      return next;
    });
  }

  // FLAT SEARCH MODE (when query is non-empty)
  const flatFiltered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [] as HostRecord[];
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(needle) ||
        h.host.toLowerCase().includes(needle) ||
        h.user.toLowerCase().includes(needle) ||
        (h.group?.toLowerCase() ?? "").includes(needle),
    );
  }, [hosts, q]);

  // TREE MODE (when query is empty)
  const tree = useMemo(() => buildTree(hosts), [hosts]);
  const treeRows = useMemo(
    () => (q.trim() ? [] : flatten(tree, expanded)),
    [tree, expanded, q],
  );

  // Active rows: search results in flat mode; tree rows in tree mode.
  const activeRows: Row[] = q.trim()
    ? flatFiltered.map((h) => ({ kind: "host" as const, host: h, depth: 0 }))
    : treeRows;

  useEffect(() => {
    if (idx >= activeRows.length) setIdx(Math.max(0, activeRows.length - 1));
  }, [activeRows.length, idx]);

  // Auto-scroll active row into view.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row-idx="${idx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [idx, activeRows.length]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      setIdx((i) => Math.min(activeRows.length - 1, i + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const row = activeRows[idx];
      if (!row) {
        e.preventDefault();
        return;
      }
      if (row.kind === "host") {
        onPick(row.host);
        onClose();
      } else {
        toggleExpand(row.node.path);
      }
      e.preventDefault();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !q.trim()) {
      // Tree-mode navigation: → expands a folder or moves into it,
      //                       ← collapses or moves to parent.
      const row = activeRows[idx];
      if (!row) return;
      if (e.key === "ArrowRight") {
        if (row.kind === "folder" && !expanded.has(row.node.path)) toggleExpand(row.node.path);
      } else {
        if (row.kind === "folder" && expanded.has(row.node.path)) toggleExpand(row.node.path);
      }
      e.preventDefault();
    }
  }

  const folderPadPx = (depth: number) => 12 + depth * 14;

  return (
    <div
      // Desktop: floating popover at 15vh. Mobile: full-screen sheet — no
      // backdrop dim (the picker IS the screen) and no top padding.
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[15vh] md:bg-black/60 md:backdrop-blur-sm md:pt-[15vh] max-md:bg-nx-bg max-md:backdrop-blur-none max-md:pt-0"
      {...backdropProps}
    >
      <div
        {...contentProps}
        // Desktop card vs mobile fullscreen sheet.
        className={
          "nx-modal-enter relative w-full max-w-xl overflow-hidden flex flex-col " +
          "max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 " +
          POPOVER_SURFACE
        }
      >
        <span className="nx-brackets">
          <i />
        </span>

        {/* Header — // подключение  > connect  [x] (по дизайн-хэндофу) */}
        <div className="nx-safe-top flex items-baseline gap-3 px-[22px] pt-5 pb-4 shrink-0">
          <span className="text-micro uppercase tracking-[0.22em] text-nx-accent">
            // {t("connect.kicker")}
          </span>
          <div className="text-h2 text-nx-text font-mono">
            <span className="text-nx-accent mr-2">&gt;</span>
            {t("connect.title")}
          </div>
          <button
            onClick={onClose}
            aria-label={t("picker.close") ?? "Close"}
            className="ml-auto p-1.5 text-nx-muted hover:text-nx-text"
          >
            <X size={14} />
          </button>
        </div>

        {/* Smart field — bordered input with ">" inside, filters hosts AND is the
            quick-connect target. */}
        <div className="px-[22px] shrink-0">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-nx-accent font-bold pointer-events-none">
              &gt;
            </span>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // Выделенная сохранённая строка имеет приоритет: ↑↓ выбирают её,
                  // ↵ подключает. Быстрое подключение по ↵ — ТОЛЬКО когда среди
                  // сохранённых нет совпадений (список пуст).
                  if (activeRows.length > 0) {
                    onKey(e);
                  } else if (quick.kind === "ready") {
                    runQuickConnect();
                    e.preventDefault();
                  }
                } else {
                  onKey(e);
                }
              }}
              placeholder={t("connect.search_placeholder")}
              className="nx-focus w-full pl-7 pr-3 py-2.5 text-body bg-nx-bg border border-nx-border rounded-nx text-nx-text placeholder-nx-muted outline-none focus:border-nx-accent font-mono"
            />
          </div>
        </div>

        {/* Contextual quick-connect card — appears whenever the field is non-empty */}
        {onQuickConnect && quick.kind !== "idle" && (
          <div className="px-3.5 pt-3 shrink-0">
            <QuickConnectCard
              state={quick}
              port={qcPort}
              onPort={(v) => setQcPort(v.replace(/\D/g, ""))}
              save={qcSave}
              onSave={setQcSave}
              login={login}
              onLogin={setLogin}
              password={password}
              onPassword={setPassword}
              onRun={runQuickConnect}
              onFinish={finishConnect}
              onCancel={() => setQuick({ kind: "ready" })}
            />
          </div>
        )}

        {/* Saved hosts header — count / matches by the same query */}
        <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-1.5 shrink-0">
          <span className="text-micro uppercase tracking-[0.16em] text-nx-soft">
            // {t("connect.saved_hosts")}
          </span>
          <span className="ml-auto text-meta text-nx-muted">
            {q.trim()
              ? t("connect.matches", { n: activeRows.length, total: hosts.length })
              : t("connect.host_count", {
                  hosts: hosts.length,
                  folders: new Set(hosts.map((h) => h.group).filter(Boolean)).size,
                })}
          </span>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="max-h-[50vh] overflow-y-auto py-1 max-md:max-h-none max-md:flex-1"
        >
          {activeRows.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-meta text-nx-muted">
              {hosts.length === 0 ? t("picker.no_hosts") : t("picker.no_match")}
            </div>
          ) : (
            activeRows.map((row, i) => {
              const active = i === idx;
              if (row.kind === "folder") {
                const isOpen = expanded.has(row.node.path);
                const childCount = countSubtreeHosts(row.node);
                return (
                  <div
                    key={"f:" + row.node.path}
                    data-row-idx={i}
                    data-active={active || undefined}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => toggleExpand(row.node.path)}
                    style={{ paddingLeft: folderPadPx(row.depth) }}
                    className="nx-row grid grid-cols-[16px_16px_1fr_auto] gap-2 items-center pr-3.5 py-1.5 max-md:py-3 cursor-pointer"
                  >
                    {isOpen ? (
                      <ChevronDown size={12} className="text-nx-muted shrink-0" />
                    ) : (
                      <ChevronRight size={12} className="text-nx-muted shrink-0" />
                    )}
                    <Folder size={12} className="text-nx-muted shrink-0" />
                    <span
                      className={
                        "truncate text-lead " +
                        (active ? "text-nx-accent" : "text-nx-text")
                      }
                    >
                      {row.node.name}
                    </span>
                    <span className="text-micro uppercase tracking-wider px-1.5 rounded-nx-sm border border-nx-border text-nx-muted whitespace-nowrap">
                      {childCount}
                    </span>
                  </div>
                );
              }
              const h = row.host;
              return (
                <div
                  key={"h:" + h.id}
                  data-row-idx={i}
                  data-active={active || undefined}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => {
                    onPick(h);
                    onClose();
                  }}
                  style={{ paddingLeft: folderPadPx(row.depth) + 18 }}
                  className="nx-row grid grid-cols-[16px_1fr_auto] gap-2.5 items-center pr-3.5 py-2 max-md:py-3 cursor-pointer"
                >
                  <Server size={12} className="text-nx-muted shrink-0" />
                  <div className="min-w-0">
                    <div
                      className={
                        "truncate text-lead " +
                        (active ? "text-nx-accent" : "text-nx-text")
                      }
                    >
                      <Highlighted text={h.name} query={q} />
                    </div>
                    <div className="text-meta text-nx-muted truncate">
                      {h.user}@{h.host}
                      {h.port !== 22 && `:${h.port}`}
                    </div>
                  </div>
                  {q.trim() && h.group && (
                    <span className="text-micro uppercase tracking-wider px-1.5 rounded-nx-sm border border-nx-border text-nx-muted whitespace-nowrap">
                      <Highlighted text={h.group} query={q} />
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        <PopoverDivider />
        {/* Footer — keyboard hints + demoted "add host" action. */}
        <div className="shrink-0 px-3.5 py-2.5 flex items-center gap-4 text-micro uppercase tracking-[0.1em] text-nx-muted bg-nx-bg-2">
          <span className="max-md:hidden">
            <kbd className="text-nx-accent">↑↓</kbd> {t("connect.nav")}
          </span>
          {!q.trim() && (
            <span className="max-md:hidden">
              <kbd className="text-nx-accent">←→</kbd> {t("connect.folder")}
            </span>
          )}
          <span className="max-md:hidden">
            <kbd className="text-nx-accent">↵</kbd> {t("connect.open")}
          </span>
          {onCreateNew && (
            <button
              onClick={() => {
                onCreateNew();
                onClose();
              }}
              className="ml-auto inline-flex items-center gap-1.5 text-nx-accent normal-case tracking-normal text-meta hover:underline"
            >
              <Plus size={14} /> {t("connect.add_host")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
