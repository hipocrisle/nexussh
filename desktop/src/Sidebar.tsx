// Sidebar — host list, search, add button, collapsible groups, collapsible itself.
//
// Click semantics:
//   Single click on host  → select (highlight + parent shows info card)
//   Double click on host  → connect (open new tab)
//   Right click on host   → context menu (Connect / Edit / Duplicate / Move / Delete)
//   Right click on folder → context menu (Rename / Delete)

import { useEffect, useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Search,
  Server,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import {
  HostRecord,
  listHosts,
  deleteHost,
  renameFolder,
  deleteFolder,
  moveHostToFolder,
  loadKnownFolders,
  addKnownFolder,
  removeKnownFolder,
  renameKnownFolder,
} from "./hosts";
import { HostDialog } from "./HostDialog";
import { MenuItem } from "./ContextMenu";

interface Props {
  onConnect: (h: HostRecord) => void;
  onSelect?: (h: HostRecord) => void;
  selectedId?: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Parent renders the menu — sidebar just emits coords + items. */
  onContextMenu?: (x: number, y: number, items: MenuItem[]) => void;
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
  onSelect,
  selectedId,
  collapsed,
  onToggleCollapsed,
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

  const reload = useCallback(async () => setHosts(await listHosts()), []);

  useEffect(() => {
    reload();
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

  const groups = useMemo(() => {
    const m = new Map<string, HostRecord[]>();
    for (const h of filtered) {
      const g = h.group ?? ungroupedLabel;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(h);
    }
    // Include empty folders the user created via "+ Folder"
    for (const f of knownFolders) {
      if (!m.has(f)) m.set(f, []);
    }
    for (const list of m.values()) {
      list.sort((a, b) => {
        if (a.lastUsedAt && b.lastUsedAt) {
          return b.lastUsedAt.localeCompare(a.lastUsedAt);
        }
        if (a.lastUsedAt) return -1;
        if (b.lastUsedAt) return 1;
        return a.name.localeCompare(b.name);
      });
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, ungroupedLabel, knownFolders]);

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
        onClick: async () => {
          await moveHostToFolder(h.id, g);
          reload();
        },
      }));
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
      onClick: async () => {
        const name = window.prompt(t("sidebar.new_folder_prompt"));
        if (name && name.trim()) {
          await moveHostToFolder(h.id, name.trim());
          reload();
        }
      },
    });

    onContextMenu?.(e.clientX, e.clientY, [
      { label: t("sidebar.menu_connect"), onClick: () => onConnect(h) },
      { label: t("sidebar.menu_edit"), onClick: () => setDialog({ kind: "edit", rec: h }) },
      {
        label: t("sidebar.menu_duplicate"),
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
      { separator: true, label: "" },
      ...moveItems,
      { separator: true, label: "" },
      {
        label: t("sidebar.menu_delete"),
        onClick: () => onRemoveHost(h),
        destructive: true,
      },
    ]);
  }

  function onFolderContextMenu(e: React.MouseEvent, group: string) {
    e.preventDefault();
    e.stopPropagation();
    // Don't allow rename/delete on the synthetic "ungrouped" bucket.
    if (group === ungroupedLabel) {
      onContextMenu?.(e.clientX, e.clientY, [
        {
          label: t("sidebar.menu_collapse_group"),
          onClick: () => toggleGroup(group),
        },
      ]);
      return;
    }
    onContextMenu?.(e.clientX, e.clientY, [
      {
        label: t("sidebar.menu_rename_folder"),
        onClick: async () => {
          const name = window.prompt(t("sidebar.rename_folder_prompt"), group);
          if (name && name.trim() && name.trim() !== group) {
            await renameFolder(group, name.trim());
            renameKnownFolder(group, name.trim());
            refreshFolders();
            reload();
          }
        },
      },
      {
        label: t("sidebar.menu_collapse_group"),
        onClick: () => toggleGroup(group),
      },
      { separator: true, label: "" },
      {
        label: t("sidebar.menu_delete_folder"),
        onClick: async () => {
          if (!confirm(t("sidebar.delete_folder_confirm", { name: group })))
            return;
          await deleteFolder(group);
          removeKnownFolder(group);
          refreshFolders();
          reload();
        },
        destructive: true,
      },
    ]);
  }

  // ---------------------------------------------------------------------
  // Drag-and-drop hosts between folders
  // ---------------------------------------------------------------------
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  function onHostDragStart(e: React.DragEvent, host: HostRecord) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-nexussh-host-id", host.id);
    // Some Linux WebKit2 builds also need text/plain to consider it a real drag.
    e.dataTransfer.setData("text/plain", host.id);
  }

  function onFolderDragOver(e: React.DragEvent, group: string) {
    if (!e.dataTransfer.types.includes("application/x-nexussh-host-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverGroup !== group) setDragOverGroup(group);
  }

  function onFolderDragLeave(group: string) {
    if (dragOverGroup === group) setDragOverGroup(null);
  }

  async function onFolderDrop(e: React.DragEvent, group: string) {
    e.preventDefault();
    setDragOverGroup(null);
    const id = e.dataTransfer.getData("application/x-nexussh-host-id");
    if (!id) return;
    const target = group === ungroupedLabel ? null : group;
    await moveHostToFolder(id, target);
    reload();
  }

  function makeEmptyAreaMenu(): MenuItem[] {
    return [
      {
        label: t("sidebar.menu_add_host"),
        onClick: () => setDialog({ kind: "add" }),
      },
      {
        label: t("sidebar.menu_new_folder"),
        onClick: () => {
          const name = window.prompt(t("sidebar.new_folder_prompt"));
          if (name && name.trim()) {
            addKnownFolder(name.trim());
            refreshFolders();
          }
        },
      },
    ];
  }

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
    <aside className="w-64 shrink-0 h-full bg-[var(--nx-bg-secondary)] border-r border-[var(--nx-border)] flex flex-col">
      <div className="p-3 border-b border-[var(--nx-border)] flex gap-2 items-center">
        <Search size={14} className="text-[var(--nx-text-muted)]" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("sidebar.filter_placeholder")}
          className="flex-1 min-w-0 bg-transparent text-[var(--nx-text-primary)] placeholder-[var(--nx-text-muted)] font-mono text-sm focus:outline-none"
        />
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
        {groups.length === 0 && (
          <div className="text-center text-[var(--nx-text-muted)] font-mono text-xs p-6">
            {t("sidebar.empty_state")}
            <br />
            <button
              onClick={() => setDialog({ kind: "add" })}
              className="mt-2 text-[var(--nx-accent)] hover:text-[var(--nx-accent)] underline"
            >
              {t("sidebar.add_first")}
            </button>
          </div>
        )}

        {groups.map(([g, list]) => {
          const isCollapsed = collapsedGroups.has(g);
          return (
            <div key={g} className="mb-1">
              <button
                onClick={() => toggleGroup(g)}
                onContextMenu={(e) => onFolderContextMenu(e, g)}
                onDragOver={(e) => onFolderDragOver(e, g)}
                onDragLeave={() => onFolderDragLeave(g)}
                onDrop={(e) => onFolderDrop(e, g)}
                className={
                  "w-full px-2 py-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--nx-text-muted)] font-mono hover:bg-[var(--nx-bg-panel)] hover:text-[var(--nx-text-soft)] " +
                  (dragOverGroup === g
                    ? "bg-[var(--nx-bg-panel)] text-[var(--nx-accent)]"
                    : "")
                }
              >
                {isCollapsed ? (
                  <ChevronRight size={10} />
                ) : (
                  <ChevronDown size={10} />
                )}
                <span className="truncate">{g}</span>
                <span className="ml-auto text-[var(--nx-text-muted)]">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((h) => {
                  const isSelected = selectedId === h.id;
                  return (
                    <div
                      key={h.id}
                      draggable
                      onDragStart={(e) => onHostDragStart(e, h)}
                      onClick={() =>
                        clickMode === "connect" ? onConnect(h) : onSelect?.(h)
                      }
                      onDoubleClick={() => onConnect(h)}
                      onContextMenu={(e) => onHostContextMenu(e, h)}
                      title={t("sidebar.host_hint")}
                      className={
                        "group px-3 py-1.5 flex items-center gap-2 cursor-pointer " +
                        (isSelected
                          ? "bg-[var(--nx-bg-panel)] border-l-2 border-[var(--nx-accent)]"
                          : "hover:bg-[var(--nx-bg-panel)] border-l-2 border-transparent")
                      }
                    >
                      <Server
                        size={12}
                        className={
                          isSelected
                            ? "text-[var(--nx-accent)] shrink-0"
                            : "text-[var(--nx-accent2)] shrink-0"
                        }
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[var(--nx-text-primary)] font-mono text-sm truncate">
                          {h.name}
                        </div>
                        <div className="text-[var(--nx-text-muted)] font-mono text-xs truncate">
                          {h.user}@{h.host}:{h.port}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
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
