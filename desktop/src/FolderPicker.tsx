// Modal folder browser used wherever we need to choose a folder path:
//   - host context menu → "Move to folder…"
//   - HostDialog → group field
//
// Folder paths use "/" separators (same convention as Sidebar). The tree is
// built from all known group paths plus all intermediate prefixes so a host
// in "a/b/c" surfaces "a" and "a/b" as expandable parents.

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronDown, Folder, FolderPlus, FolderX, X, Cloud, HardDrive } from "lucide-react";
import { useBackdropClose } from "./useBackdropClose";
import type { KnownFolder } from "./hosts";

const POPOVER_SURFACE =
  "bg-nx-bg-2 border border-nx-border rounded-nx shadow-2xl";

const EXPANDED_LS_KEY = "nexussh.folderPickerExpanded";

interface FolderNode {
  path: string;
  name: string;
  children: Map<string, FolderNode>;
}

function buildTree(paths: string[]): FolderNode {
  const root: FolderNode = { path: "", name: "", children: new Map() };
  for (const p of paths) {
    if (!p) continue;
    const parts = p.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      let child = node.children.get(part);
      if (!child) {
        child = { path: acc, name: part, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
  }
  return root;
}

type Row =
  | { kind: "folder"; node: FolderNode; depth: number }
  | { kind: "ungroup" }
  | { kind: "new-folder" };

function flatten(root: FolderNode, expanded: Set<string>): Row[] {
  const out: Row[] = [];
  function walk(n: FolderNode, depth: number) {
    const kids = Array.from(n.children.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const c of kids) {
      out.push({ kind: "folder", node: c, depth });
      if (expanded.has(c.path)) walk(c, depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_LS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {}
  return new Set();
}

function saveExpanded(s: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_LS_KEY, JSON.stringify([...s]));
  } catch {}
}

interface Props {
  /** Existing folders + their category (Cloud/Local). */
  paths: KnownFolder[];
  /** Currently-selected folder path; gets a check mark. null = ungrouped. */
  current?: string | null;
  /** Show the "Without folder" action at the top? Default: true. */
  allowUngroup?: boolean;
  /** Show the "+ New folder…" action? Default: true. */
  allowCreate?: boolean;
  /** Returns the chosen folder + its category (folder = category). */
  onPick: (path: string | null, synced: boolean) => void;
  onClose: () => void;
  /** Modal title. Defaults to "Move to folder…". */
  title?: string;
}

export function FolderPicker({
  paths,
  current,
  allowUngroup = true,
  allowCreate = true,
  onPick,
  onClose,
  title,
}: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [creating, setCreating] = useState<string | null>(null); // parent path under which to create
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (creating != null) newInputRef.current?.focus();
  }, [creating]);

  // Auto-expand all ancestors of the current selection on mount so it's
  // visible. Don't persist this expansion — it's incidental.
  useEffect(() => {
    if (!current) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = current.split("/");
      for (let i = 1; i <= parts.length; i++) {
        next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }, [current]);

  const tree = useMemo(() => buildTree(paths.map((p) => p.path)), [paths]);
  // path → category (Cloud=true / Local=false), for the icon + onPick.
  const catMap = useMemo(
    () => new Map(paths.map((p) => [p.path, p.synced])),
    [paths],
  );

  // When searching, flatten ALL folders (matching the substring) instead of
  // honoring the expand state — same UX as TabPicker.
  const rows = useMemo<Row[]>(() => {
    if (q.trim()) {
      const term = q.trim().toLowerCase();
      const collectAll: Row[] = [];
      function walk(n: FolderNode) {
        for (const c of Array.from(n.children.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (
            c.path.toLowerCase().includes(term) ||
            c.name.toLowerCase().includes(term)
          ) {
            collectAll.push({ kind: "folder", node: c, depth: 0 });
          }
          walk(c);
        }
      }
      walk(tree);
      return collectAll;
    }
    return flatten(tree, expanded);
  }, [tree, expanded, q]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveExpanded(next);
      return next;
    });
  }

  function commitNew() {
    const name = newName.trim();
    if (!name) {
      setCreating(null);
      setNewName("");
      return;
    }
    const path = creating ? creating + "/" + name : name;
    // New folder inherits the category of its parent; a new root folder is Local.
    const synced = creating ? (catMap.get(creating) ?? false) : false;
    onPick(path, synced);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[15vh] max-md:pt-0 max-md:bg-nx-bg max-md:backdrop-blur-none"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className={
          "nx-modal-enter w-full max-w-md flex flex-col overflow-hidden max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 " +
          POPOVER_SURFACE
        }
      >
        {/* Header */}
        <div className="nx-safe-top flex items-center gap-2.5 px-3.5 py-2.5 border-b border-nx-divider shrink-0">
          <Folder size={14} className="text-nx-accent shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("folderpicker.placeholder")}
            className="flex-1 bg-transparent border-none text-nx-text font-mono text-lead outline-none placeholder-nx-muted"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("folderpicker.close")}
            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-nx-sm border border-nx-border bg-nx-panel text-nx-text hover:bg-nx-elevated"
          >
            <X size={14} />
          </button>
        </div>
        {title && (
          <div className="px-3.5 py-1.5 text-micro uppercase tracking-wider text-nx-soft border-b border-nx-divider shrink-0">
            // {title}
          </div>
        )}

        {/* Action rows: Ungroup + New folder. Always at top. */}
        <div className="shrink-0">
          {allowUngroup && (
            <div
              onClick={() => onPick(null, false)}
              className={
                "nx-row grid grid-cols-[16px_1fr_auto] gap-2.5 items-center px-3.5 py-2 max-md:py-3 cursor-pointer text-nx-text hover:bg-nx-elevated"
              }
            >
              <FolderX size={14} className="text-nx-muted shrink-0" />
              <span className="text-lead">{t("folderpicker.ungroup")}</span>
              {current == null && (
                <span className="text-nx-accent text-meta">✓</span>
              )}
            </div>
          )}
          {allowCreate && creating === null && (
            <div
              onClick={() => {
                setCreating("");
                setNewName("");
              }}
              className="nx-row grid grid-cols-[16px_1fr] gap-2.5 items-center px-3.5 py-2 max-md:py-3 cursor-pointer text-nx-accent hover:bg-nx-elevated"
            >
              <FolderPlus size={14} className="shrink-0" />
              <span className="text-lead">{t("folderpicker.new_root")}</span>
            </div>
          )}
          {allowCreate && creating !== null && (
            <div className="grid grid-cols-[16px_1fr_auto_auto] gap-2.5 items-center px-3.5 py-2 max-md:py-3 bg-nx-elevated">
              <FolderPlus size={14} className="text-nx-accent shrink-0" />
              <input
                ref={newInputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitNew();
                  else if (e.key === "Escape") {
                    setCreating(null);
                    setNewName("");
                  }
                }}
                placeholder={
                  creating
                    ? t("folderpicker.new_under", { parent: creating })
                    : t("folderpicker.new_root_ph")
                }
                className="bg-transparent border border-nx-border rounded-nx-sm px-2 py-1 text-nx-text font-mono text-meta outline-none focus:border-nx-accent"
              />
              <button
                type="button"
                onClick={commitNew}
                className="px-2 py-1 text-meta rounded-nx-sm border border-nx-accent text-nx-accent hover:bg-[var(--nx-accent)]/10"
              >
                ✓
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(null);
                  setNewName("");
                }}
                className="px-2 py-1 text-meta rounded-nx-sm border border-nx-border text-nx-muted hover:bg-nx-elevated"
              >
                ✕
              </button>
            </div>
          )}
          <div className="h-px bg-nx-divider" />
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-meta text-nx-muted">
              {q.trim() ? t("folderpicker.no_match") : t("folderpicker.no_folders")}
            </div>
          ) : (
            rows.map((row) => {
              if (row.kind !== "folder") return null;
              const n = row.node;
              const isOpen = expanded.has(n.path);
              const childCount = n.children.size;
              const isCurrent = n.path === (current ?? "");
              return (
                <div
                  key={"f:" + n.path}
                  className="nx-row grid grid-cols-[16px_16px_1fr_auto_auto] gap-2 items-center pr-3.5 py-1.5 max-md:py-3 cursor-pointer hover:bg-nx-elevated"
                  style={{ paddingLeft: 12 + row.depth * 14 }}
                >
                  {childCount > 0 ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(n.path);
                      }}
                      className="inline-flex items-center justify-center w-4 h-4"
                    >
                      {isOpen ? (
                        <ChevronDown size={12} className="text-nx-muted shrink-0" />
                      ) : (
                        <ChevronRight size={12} className="text-nx-muted shrink-0" />
                      )}
                    </button>
                  ) : (
                    <span />
                  )}
                  {catMap.get(n.path) ? (
                    <Cloud size={12} className="text-nx-accent shrink-0" />
                  ) : (
                    <HardDrive size={12} className="text-nx-muted shrink-0" />
                  )}
                  <span
                    onClick={() => onPick(n.path, catMap.get(n.path) ?? false)}
                    className="truncate text-lead text-nx-text"
                  >
                    {n.name}
                  </span>
                  {allowCreate && (
                    <button
                      type="button"
                      title={t("folderpicker.new_under_short")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCreating(n.path);
                        setNewName("");
                        if (!expanded.has(n.path)) toggle(n.path);
                      }}
                      className="inline-flex items-center justify-center w-5 h-5 rounded-nx-sm border border-transparent hover:border-nx-border text-nx-muted hover:text-nx-accent"
                    >
                      <FolderPlus size={11} />
                    </button>
                  )}
                  {isCurrent && (
                    <span className="text-nx-accent text-meta">✓</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
