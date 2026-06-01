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
import { Server, ChevronRight, ChevronDown, Folder, Plus } from "lucide-react";
import { HostRecord, listHosts } from "./hosts";
import { useBackdropClose } from "./useBackdropClose";
import { POPOVER_SURFACE, PopoverDivider } from "./Popover";

interface Props {
  onPick: (h: HostRecord) => void;
  onCreateNew?: () => void;
  onClose: () => void;
}

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

export function TabPicker({ onPick, onCreateNew, onClose }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[15vh]"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className={"nx-modal-enter w-full max-w-xl overflow-hidden " + POPOVER_SURFACE}
      >
        {/* Search header */}
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-nx-divider">
          <span className="text-nx-accent">&gt;</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
            placeholder={t("picker.placeholder")}
            className="flex-1 bg-transparent border-none text-nx-text font-mono text-lead outline-none placeholder-nx-muted"
          />
          <span className="text-micro uppercase tracking-wider px-1.5 rounded-nx-sm border border-nx-border text-nx-muted whitespace-nowrap">
            {q.trim() ? `${activeRows.length} ${t("picker.results")}` : `${hosts.length}`}
          </span>
        </div>

        {/* Create-new row, only when not searching */}
        {!q.trim() && onCreateNew && (
          <>
            <div
              onClick={() => {
                onCreateNew();
                onClose();
              }}
              className="nx-row grid grid-cols-[16px_1fr] gap-2.5 items-center px-3.5 py-2 cursor-pointer text-nx-accent hover:bg-nx-elevated"
            >
              <Plus size={14} className="shrink-0" />
              <span className="text-lead">{t("picker.create_new")}</span>
            </div>
            <PopoverDivider />
          </>
        )}

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {activeRows.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-meta text-nx-muted">
              {hosts.length === 0 ? t("picker.no_hosts") : t("picker.no_match")}
            </div>
          ) : (
            activeRows.map((row, i) => {
              const active = i === idx;
              if (row.kind === "folder") {
                const isOpen = expanded.has(row.node.path);
                const childCount = row.node.hosts.length + row.node.children.size;
                return (
                  <div
                    key={"f:" + row.node.path}
                    data-row-idx={i}
                    data-active={active || undefined}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => toggleExpand(row.node.path)}
                    style={{ paddingLeft: folderPadPx(row.depth) }}
                    className="nx-row grid grid-cols-[16px_16px_1fr_auto] gap-2 items-center pr-3.5 py-1.5 cursor-pointer"
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
                  className="nx-row grid grid-cols-[16px_1fr_auto] gap-2.5 items-center pr-3.5 py-2 cursor-pointer"
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
        {/* Footer hints */}
        <div className="px-3.5 py-2 flex gap-4 text-micro uppercase tracking-[0.12em] text-nx-muted">
          <span>
            <kbd className="text-nx-accent">↑ ↓</kbd> {t("picker.hint_move")}
          </span>
          {!q.trim() && (
            <span>
              <kbd className="text-nx-accent">← →</kbd> {t("picker.hint_fold")}
            </span>
          )}
          <span>
            <kbd className="text-nx-accent">↵</kbd> {t("picker.hint_open")}
          </span>
          <span className="ml-auto">
            <kbd className="text-nx-accent">esc</kbd> {t("picker.hint_close")}
          </span>
        </div>
      </div>
    </div>
  );
}
