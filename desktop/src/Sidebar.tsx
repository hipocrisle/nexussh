// Sidebar — host list, search, add button, collapsible groups, collapsible itself.
//
// Click semantics:
//   Single click on host  → select (highlight + parent shows info card)
//   Double click on host  → connect (open new tab)
//   Right click on host   → context menu (Connect / Edit / Duplicate / Move / Delete)
//   Right click on folder → context menu (Rename / Delete)

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Search,
  Server,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Folder,
  FolderPlus,
  Edit2,
  Copy,
  Trash2,
  ArrowDownAZ,
  Clock,
  GripVertical,
} from "lucide-react";
import {
  HostRecord,
  listHosts,
  deleteHost,
  renameFolder,
  deleteFolder,
  moveHostToFolder,
  reorderHosts,
  loadKnownFolders,
  addKnownFolder,
  removeKnownFolder,
  renameKnownFolder,
  onHostsChanged,
} from "./hosts";
import { HostDialog } from "./HostDialog";
import { MenuItem } from "./ContextMenu";
import { askPrompt } from "./dialogs";

// Folders form a tree via "/"-separated group paths ("Work/Office-A/Switches").
interface FolderNode {
  path: string; // full path
  name: string; // last segment
  children: Map<string, FolderNode>;
  hosts: HostRecord[];
}

type SortMode = "recent" | "alpha" | "manual";
const SORT_MODE_LS = "nexussh.sidebarSort";
const SORT_CYCLE: SortMode[] = ["recent", "alpha", "manual"];

function hostCmp(a: HostRecord, b: HostRecord, mode: SortMode): number {
  if (mode === "alpha") return a.name.localeCompare(b.name);
  if (mode === "manual") {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  }
  // recent (default): most-recently-used first, then name
  if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
  if (a.lastUsedAt) return -1;
  if (b.lastUsedAt) return 1;
  return a.name.localeCompare(b.name);
}

function countHosts(n: FolderNode): number {
  let c = n.hosts.length;
  n.children.forEach((ch) => (c += countHosts(ch)));
  return c;
}

function sortedChildren(n: FolderNode): FolderNode[] {
  return Array.from(n.children.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Left padding (px) for a folder header / host row at a given tree depth.
const folderPad = (depth: number) => 12 + depth * 14;

interface Props {
  onConnect: (h: HostRecord) => void;
  onSftp?: (h: HostRecord) => void;
  onSelect?: (h: HostRecord) => void;
  selectedId?: string | null;
  /** host.id of the currently focused tab — gets the blinking caret. */
  activeHostId?: string | null;
  /** host.ids of ALL hosts with an open tab — each gets the "live" badge. */
  openHostIds?: Set<string>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Expanded-state width in px (parent owns it so the drag-divider lives in
   *  the layout). Ignored when collapsed. */
  width?: number;
  /** Parent renders the menu — sidebar just emits coords + items. */
  onContextMenu?: (
    x: number,
    y: number,
    items: MenuItem[],
    title?: { kicker?: string; main?: string },
  ) => void;
  /** From settings: 'connect' = single click connects, 'select' = single
   *  click selects and shows info, double-click connects. */
  clickMode?: "connect" | "select";
}

const COLLAPSED_GROUPS_LS = "nexussh.collapsedGroups";

function readCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_LS);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(s: Set<string>) {
  localStorage.setItem(COLLAPSED_GROUPS_LS, JSON.stringify(Array.from(s)));
}

export function Sidebar({
  onConnect,
  onSftp,
  onSelect,
  selectedId,
  activeHostId,
  openHostIds,
  collapsed,
  onToggleCollapsed,
  width = 256,
  onContextMenu,
  clickMode = "select",
}: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<
    { kind: "add" } | { kind: "edit"; rec: HostRecord } | null
  >(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    readCollapsedGroups(),
  );
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const v = localStorage.getItem(SORT_MODE_LS) as SortMode | null;
    return v && SORT_CYCLE.includes(v) ? v : "recent";
  });
  function cycleSortMode() {
    const next = SORT_CYCLE[(SORT_CYCLE.indexOf(sortMode) + 1) % SORT_CYCLE.length];
    setSortMode(next);
    localStorage.setItem(SORT_MODE_LS, next);
  }

  const reload = useCallback(async () => setHosts(await listHosts()), []);

  useEffect(() => {
    reload();
    // Re-fetch whenever saveHost/deleteHost fire the global event — e.g.
    // after Settings → Import dumps a batch of new entries we want the
    // sidebar to show them without the user having to relaunch the app.
    return onHostsChanged(reload);
  }, [reload]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.host.toLowerCase().includes(q) ||
        h.user.toLowerCase().includes(q) ||
        (h.group ?? "").toLowerCase().includes(q),
    );
  }, [hosts, filter]);

  const ungroupedLabel = t("sidebar.no_group");

  const [knownFolders, setKnownFolders] = useState<string[]>(() =>
    loadKnownFolders(),
  );
  const refreshFolders = useCallback(() => setKnownFolders(loadKnownFolders()), []);

  const { root, ungrouped } = useMemo(() => {
    const root: FolderNode = { path: "", name: "", children: new Map(), hosts: [] };
    const ensure = (path: string): FolderNode => {
      let node = root;
      let acc = "";
      for (const seg of path.split("/")) {
        if (!seg) continue;
        acc = acc ? acc + "/" + seg : seg;
        let child = node.children.get(seg);
        if (!child) {
          child = { path: acc, name: seg, children: new Map(), hosts: [] };
          node.children.set(seg, child);
        }
        node = child;
      }
      return node;
    };
    const ungrouped: HostRecord[] = [];
    for (const h of filtered) {
      if (h.group) ensure(h.group).hosts.push(h);
      else ungrouped.push(h);
    }
    // Empty folders the user created via "+ Folder" (may be nested paths).
    for (const f of knownFolders) if (f.trim()) ensure(f);
    const sortRec = (n: FolderNode) => {
      n.hosts.sort((a, b) => hostCmp(a, b, sortMode));
      n.children.forEach(sortRec);
    };
    sortRec(root);
    ungrouped.sort((a, b) => hostCmp(a, b, sortMode));
    return { root, ungrouped };
  }, [filtered, knownFolders, sortMode]);

  const isEmpty = root.children.size === 0 && ungrouped.length === 0;

  const knownGroups = useMemo(
    () =>
      Array.from(
        new Set([
          ...(hosts.map((h) => h.group).filter(Boolean) as string[]),
          ...knownFolders,
        ]),
      ),
    [hosts, knownFolders],
  );

  function toggleGroup(g: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      writeCollapsedGroups(next);
      return next;
    });
  }

  async function onRemoveHost(h: HostRecord) {
    if (!confirm(t("dialog.delete_confirm", { name: h.name }))) return;
    await deleteHost(h.id);
    reload();
  }

  function onHostContextMenu(e: React.MouseEvent, h: HostRecord) {
    e.preventDefault();
    e.stopPropagation();
    const moveItems: MenuItem[] = knownGroups
      .filter((g) => g !== h.group)
      .map((g) => ({
        label: g,
        icon: <Folder size={13} />,
        onClick: async () => {
          await moveHostToFolder(h.id, g);
          reload();
        },
      }));
    if (h.group) {
      // Current folder — shown checked, non-actionable.
      moveItems.unshift({
        label: h.group,
        icon: <Folder size={13} />,
        checked: true,
      });
    }
    moveItems.push({
      label: t("sidebar.move_ungroup"),
      onClick: async () => {
        await moveHostToFolder(h.id, null);
        reload();
      },
      disabled: !h.group,
    });
    moveItems.push({
      label: t("sidebar.move_new_folder"),
      icon: <FolderPlus size={13} />,
      onClick: async () => {
        const name = await askPrompt(t("sidebar.new_folder_prompt"));
        if (name && name.trim()) {
          await moveHostToFolder(h.id, name.trim());
          reload();
        }
      },
    });

    onContextMenu?.(
      e.clientX,
      e.clientY,
      [
        {
          label: t("sidebar.menu_connect"),
          icon: <Play size={13} />,
          shortcut: "↵",
          onClick: () => onConnect(h),
        },
        {
          label: t("sidebar.menu_sftp"),
          icon: <Folder size={13} />,
          onClick: () => onSftp?.(h),
        },
        {
          label: t("sidebar.menu_edit"),
          icon: <Edit2 size={13} />,
          onClick: () => setDialog({ kind: "edit", rec: h }),
        },
        {
          label: t("sidebar.menu_duplicate"),
          icon: <Copy size={13} />,
          onClick: async () => {
            const copy: HostRecord = {
              ...h,
              id: "h-" + crypto.randomUUID(),
              name: h.name + " (копия)",
              lastUsedAt: undefined,
            };
            const { saveHost } = await import("./hosts");
            await saveHost(copy);
            reload();
          },
        },
        { sectionLabel: t("sidebar.menu_move_section"), label: "" },
        ...moveItems,
        { separator: true, label: "" },
        {
          label: t("sidebar.menu_delete"),
          icon: <Trash2 size={13} />,
          onClick: () => onRemoveHost(h),
          destructive: true,
        },
      ],
      { kicker: h.group || undefined, main: `${h.user}@${h.host}` },
    );
  }

  function onFolderContextMenu(e: React.MouseEvent, path: string) {
    e.preventDefault();
    e.stopPropagation();
    // Don't allow rename/delete on the synthetic "ungrouped" bucket.
    if (path === ungroupedLabel) {
      onContextMenu?.(e.clientX, e.clientY, [
        {
          label: t("sidebar.menu_collapse_group"),
          onClick: () => toggleGroup(path),
        },
      ]);
      return;
    }
    const slash = path.lastIndexOf("/");
    const parent = slash >= 0 ? path.slice(0, slash) : "";
    const leaf = slash >= 0 ? path.slice(slash + 1) : path;
    onContextMenu?.(
      e.clientX,
      e.clientY,
      [
        {
          label: t("sidebar.menu_rename_folder"),
          icon: <Edit2 size={13} />,
          onClick: async () => {
            const name = await askPrompt(t("sidebar.rename_folder_prompt"), {
              defaultValue: leaf,
            });
            const next = name?.trim();
            if (!next || next === leaf || next.includes("/")) return;
            const newPath = parent ? `${parent}/${next}` : next;
            await renameFolder(path, newPath);
            renameKnownFolder(path, newPath);
            refreshFolders();
            reload();
          },
        },
        {
          label: t("sidebar.menu_new_subfolder"),
          icon: <FolderPlus size={13} />,
          onClick: async () => {
            const name = await askPrompt(
              t("sidebar.new_subfolder_prompt", { parent: leaf }),
            );
            const sub = name?.trim();
            if (!sub) return;
            addKnownFolder(`${path}/${sub}`);
            // Make sure the parent is expanded so the new child is visible.
            setCollapsedGroups((prev) => {
              const nextSet = new Set(prev);
              nextSet.delete(path);
              writeCollapsedGroups(nextSet);
              return nextSet;
            });
            refreshFolders();
          },
        },
        {
          label: t("sidebar.menu_collapse_group"),
          onClick: () => toggleGroup(path),
        },
        { separator: true, label: "" },
        {
          label: t("sidebar.menu_delete_folder"),
          icon: <Trash2 size={13} />,
          onClick: async () => {
            if (!confirm(t("sidebar.delete_folder_confirm", { name: path }))) return;
            await deleteFolder(path);
            removeKnownFolder(path);
            refreshFolders();
            reload();
          },
          destructive: true,
        },
      ],
      { main: path },
    );
  }

  // ---------------------------------------------------------------------
  // Drag-and-drop hosts between folders — custom mouse-based impl.
  // WebView2 / WKWebView don't always honor HTML5 native DnD (no drag start
  // fires), so we track mousedown/mousemove/mouseup ourselves and emit our
  // own visual feedback + drop detection.
  // ---------------------------------------------------------------------
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [draggingHost, setDraggingHost] = useState<HostRecord | null>(null);
  // When hovering another host row: where the dragged host would land.
  const [dropTarget, setDropTarget] = useState<{
    hostId: string;
    before: boolean;
  } | null>(null);
  const dragRef = useRef<{
    host: HostRecord;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);

  function onHostMouseDown(e: React.MouseEvent, host: HostRecord) {
    if (e.button !== 0) return;
    dragRef.current = {
      host,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
    };
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.started && Math.hypot(dx, dy) > 5) {
        d.started = true;
        setDraggingHost(d.host);
        document.body.style.cursor = "grabbing";
      }
      if (!d.started) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      // Reorder intent: hovering another host row → insert before/after it.
      const hostEl = el?.closest("[data-host-id]") as HTMLElement | null;
      if (hostEl && hostEl.dataset.hostId && hostEl.dataset.hostId !== d.host.id) {
        const r = hostEl.getBoundingClientRect();
        setDropTarget({
          hostId: hostEl.dataset.hostId,
          before: e.clientY < r.top + r.height / 2,
        });
        setDragOverGroup(null);
        return;
      }
      // Otherwise: move-into-folder intent (drop on a folder header).
      setDropTarget(null);
      const folderEl = el?.closest("[data-folder-header]") as HTMLElement | null;
      setDragOverGroup(folderEl?.dataset.folderHeader ?? null);
    };
    const onUp = async () => {
      const d = dragRef.current;
      dragRef.current = null;
      document.body.style.cursor = "";
      if (d && d.started) {
        if (dropTarget) {
          const tgt = hosts.find((h) => h.id === dropTarget.hostId);
          if (tgt) {
            const group = tgt.group ?? null;
            const list = hosts
              .filter((h) => (h.group ?? null) === group && h.id !== d.host.id)
              .sort((a, b) => hostCmp(a, b, sortMode));
            const idx = list.findIndex((h) => h.id === tgt.id);
            list.splice(dropTarget.before ? idx : idx + 1, 0, d.host);
            await reorderHosts(
              list.map((h) => h.id),
              group,
            );
            // Freeze the resulting order so the manual placement is what shows.
            setSortMode("manual");
            localStorage.setItem(SORT_MODE_LS, "manual");
            reload();
          }
        } else if (dragOverGroup !== null) {
          const folder = dragOverGroup === ungroupedLabel ? null : dragOverGroup;
          if (folder !== (d.host.group ?? null)) {
            await moveHostToFolder(d.host.id, folder);
            reload();
          }
        }
      }
      setDraggingHost(null);
      setDragOverGroup(null);
      setDropTarget(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragOverGroup, dropTarget, hosts, sortMode, ungroupedLabel, reload]);

  function makeEmptyAreaMenu(): MenuItem[] {
    return [
      {
        label: t("sidebar.menu_add_host"),
        onClick: () => setDialog({ kind: "add" }),
      },
      {
        label: t("sidebar.menu_new_folder"),
        onClick: async () => {
          const name = await askPrompt(t("sidebar.new_folder_prompt"));
          if (name && name.trim()) {
            addKnownFolder(name.trim());
            refreshFolders();
          }
        },
      },
    ];
  }

  const renderHost = (h: HostRecord, depth: number) => {
    const isSelected = selectedId === h.id;
    const isOpen = openHostIds?.has(h.id) ?? false; // any open tab → live badge
    const isActiveTab = h.id === activeHostId; // focused tab → blinking caret
    return (
      <div
        key={h.id}
        data-host-id={h.id}
        data-active={isSelected || undefined}
        onMouseDown={(e) => onHostMouseDown(e, h)}
        onClick={() => {
          if (draggingHost) return;
          clickMode === "connect" ? onConnect(h) : onSelect?.(h);
        }}
        onDoubleClick={() => onConnect(h)}
        onContextMenu={(e) => onHostContextMenu(e, h)}
        title={t("sidebar.host_hint")}
        style={{
          paddingLeft: folderPad(depth),
          ...(dropTarget?.hostId === h.id
            ? {
                boxShadow: dropTarget.before
                  ? "inset 0 2px 0 var(--nx-accent)"
                  : "inset 0 -2px 0 var(--nx-accent)",
              }
            : {}),
        }}
        className={
          "nx-row group grid grid-cols-[16px_1fr_auto] gap-2 items-center pr-3 py-1.5 cursor-pointer " +
          (draggingHost?.id === h.id ? "opacity-50" : "")
        }
      >
        <Server
          size={12}
          className={isSelected ? "text-nx-accent shrink-0" : "text-nx-muted shrink-0"}
        />
        <div className="min-w-0">
          <div
            className={
              "font-mono text-lead truncate " +
              (isSelected ? "text-nx-accent" : "text-nx-text")
            }
          >
            {h.name}
            {isActiveTab && <span className="nx-caret ml-1" />}
          </div>
          <div className="font-mono text-meta text-nx-muted truncate">
            {h.user}
            <span className="text-nx-soft">@</span>
            {h.host}:{h.port}
          </div>
        </div>
        {isOpen && (
          <span className="text-micro uppercase tracking-wider text-nx-accent border border-nx-accent/40 rounded-nx-sm px-1.5">
            live
          </span>
        )}
      </div>
    );
  };

  const renderFolder = (node: FolderNode, depth: number): React.ReactNode => {
    const isCollapsed = collapsedGroups.has(node.path);
    return (
      <div key={"f:" + node.path} className="mb-0.5">
        <button
          data-folder-header={node.path}
          onClick={() => toggleGroup(node.path)}
          onContextMenu={(e) => onFolderContextMenu(e, node.path)}
          style={{ paddingLeft: folderPad(depth) }}
          className={
            "w-full pr-3 py-1.5 flex items-center gap-2 text-meta uppercase tracking-[0.16em] font-mono " +
            "text-nx-soft hover:text-nx-text transition-colors duration-[80ms] " +
            (dragOverGroup === node.path ? "bg-nx-elevated shadow-glow-sm" : "")
          }
        >
          {isCollapsed ? (
            <ChevronRight size={12} className="text-nx-muted shrink-0" />
          ) : (
            <ChevronDown size={12} className="text-nx-accent shrink-0" />
          )}
          <span className="truncate">// {node.name}</span>
          <span className="ml-auto text-micro tabular-nums px-1.5 min-w-[18px] text-center rounded-full border border-nx-border bg-nx-elevated text-nx-muted">
            {countHosts(node)}
          </span>
        </button>
        {!isCollapsed && (
          <>
            {sortedChildren(node).map((c) => renderFolder(c, depth + 1))}
            {node.hosts.map((h) => renderHost(h, depth + 1))}
          </>
        )}
      </div>
    );
  };

  // Synthetic top-level bucket for hosts with no folder.
  const ungroupedNode: FolderNode = {
    path: ungroupedLabel,
    name: ungroupedLabel,
    children: new Map(),
    hosts: ungrouped,
  };

  if (collapsed) {
    return (
      <aside className="w-10 shrink-0 h-full bg-[var(--nx-bg-secondary)] border-r border-[var(--nx-border)] flex flex-col items-center py-2 gap-2">
        <button
          onClick={onToggleCollapsed}
          title={t("sidebar.expand")}
          className="text-[var(--nx-text-soft)] hover:text-[var(--nx-accent)] p-1"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          onClick={() => setDialog({ kind: "add" })}
          title={t("sidebar.add_host")}
          className="text-[var(--nx-accent)] hover:text-[var(--nx-accent)] p-1"
        >
          <Plus size={18} />
        </button>
        {dialog?.kind === "add" && (
          <HostDialog
            knownGroups={knownGroups}
            onClose={() => setDialog(null)}
            onSaved={() => {
              setDialog(null);
              reload();
            }}
          />
        )}
      </aside>
    );
  }

  return (
    <aside
      style={{ width }}
      className="shrink-0 h-full bg-[var(--nx-bg-secondary)] border-r border-[var(--nx-border)] flex flex-col"
    >
      <div className="p-3 border-b border-[var(--nx-border)] flex gap-2 items-center">
        <Search size={14} className="text-[var(--nx-text-muted)]" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("sidebar.filter_placeholder")}
          className="flex-1 min-w-0 bg-transparent text-[var(--nx-text-primary)] placeholder-[var(--nx-text-muted)] font-mono text-sm focus:outline-none"
        />
        <button
          onClick={cycleSortMode}
          title={t("sidebar.sort_hint", { mode: t(`sidebar.sort_${sortMode}`) })}
          className="text-[var(--nx-text-muted)] hover:text-[var(--nx-text-soft)] shrink-0"
        >
          {sortMode === "alpha" ? (
            <ArrowDownAZ size={16} />
          ) : sortMode === "manual" ? (
            <GripVertical size={16} />
          ) : (
            <Clock size={16} />
          )}
        </button>
        <button
          onClick={() => setDialog({ kind: "add" })}
          title={t("sidebar.add_host")}
          className="text-[var(--nx-accent)] hover:text-[var(--nx-accent)] shrink-0"
        >
          <Plus size={16} />
        </button>
        <button
          onClick={onToggleCollapsed}
          title={t("sidebar.collapse")}
          className="text-[var(--nx-text-muted)] hover:text-[var(--nx-text-soft)] shrink-0"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div
        className="flex-1 overflow-y-auto py-1"
        onContextMenu={(e) => {
          // Only react if the click was on the empty scroll area, not on a
          // child element with its own ContextMenu (host item or folder header).
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          onContextMenu?.(e.clientX, e.clientY, makeEmptyAreaMenu());
        }}
      >
        {isEmpty && (
          <div className="px-4 py-8 text-center font-mono">
            <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--nx-text-muted)] mb-1">
              // {t("sidebar.empty_kicker")}
            </div>
            <div className="text-meta text-[var(--nx-text-soft)] mb-5 leading-relaxed">
              {t("sidebar.empty_state")}
            </div>
            <button
              onClick={() => setDialog({ kind: "add" })}
              className="block w-full px-3 py-2 mb-3 rounded-nx border font-mono text-meta cursor-pointer transition-colors"
              style={{
                borderColor: "var(--nx-accent)",
                color: "var(--nx-accent)",
                background: "transparent",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--nx-elevated)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              {t("sidebar.empty_add")}
            </button>
            <div className="text-micro text-[var(--nx-text-muted)] leading-relaxed">
              {t("sidebar.empty_import_hint")}
            </div>
          </div>
        )}

        {sortedChildren(root).map((node) => renderFolder(node, 0))}
        {ungrouped.length > 0 && renderFolder(ungroupedNode, 0)}
      </div>

      {dialog?.kind === "add" && (
        <HostDialog
          knownGroups={knownGroups}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
      {dialog?.kind === "edit" && (
        <HostDialog
          initial={dialog.rec}
          knownGroups={knownGroups}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </aside>
  );
}
