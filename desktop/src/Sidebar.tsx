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

  const groups = useMemo(() => {
    const m = new Map<string, HostRecord[]>();
    for (const h of filtered) {
      const g = h.group ?? ungroupedLabel;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(h);
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
  }, [filtered, ungroupedLabel]);

  const knownGroups = useMemo(
    () =>
      Array.from(
        new Set(hosts.map((h) => h.group).filter(Boolean) as string[]),
      ),
    [hosts],
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
          reload();
        },
        destructive: true,
      },
    ]);
  }

  if (collapsed) {
    return (
      <aside className="w-10 shrink-0 h-full bg-[#080b0b] border-r border-[#1f3a3a] flex flex-col items-center py-2 gap-2">
        <button
          onClick={onToggleCollapsed}
          title={t("sidebar.expand")}
          className="text-[#7fd7ff] hover:text-[#00ff95] p-1"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          onClick={() => setDialog({ kind: "add" })}
          title={t("sidebar.add_host")}
          className="text-[#00ff95] hover:text-[#5fffb4] p-1"
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
    <aside className="w-64 shrink-0 h-full bg-[#080b0b] border-r border-[#1f3a3a] flex flex-col">
      <div className="p-3 border-b border-[#1f3a3a] flex gap-2 items-center">
        <Search size={14} className="text-[#4a5560]" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("sidebar.filter_placeholder")}
          className="flex-1 min-w-0 bg-transparent text-[#c9d1d9] placeholder-[#4a5560] font-mono text-sm focus:outline-none"
        />
        <button
          onClick={() => setDialog({ kind: "add" })}
          title={t("sidebar.add_host")}
          className="text-[#00ff95] hover:text-[#5fffb4] shrink-0"
        >
          <Plus size={16} />
        </button>
        <button
          onClick={onToggleCollapsed}
          title={t("sidebar.collapse")}
          className="text-[#4a5560] hover:text-[#7fd7ff] shrink-0"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <div className="text-center text-[#4a5560] font-mono text-xs p-6">
            {t("sidebar.empty_state")}
            <br />
            <button
              onClick={() => setDialog({ kind: "add" })}
              className="mt-2 text-[#00ff95] hover:text-[#5fffb4] underline"
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
                className="w-full px-2 py-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#4a5560] font-mono hover:bg-[#0e1414] hover:text-[#7fd7ff]"
              >
                {isCollapsed ? (
                  <ChevronRight size={10} />
                ) : (
                  <ChevronDown size={10} />
                )}
                <span className="truncate">{g}</span>
                <span className="ml-auto text-[#4a5560]">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((h) => {
                  const isSelected = selectedId === h.id;
                  return (
                    <div
                      key={h.id}
                      onClick={() => onSelect?.(h)}
                      onDoubleClick={() => onConnect(h)}
                      onContextMenu={(e) => onHostContextMenu(e, h)}
                      title={t("sidebar.host_hint")}
                      className={
                        "group px-3 py-1.5 flex items-center gap-2 cursor-pointer " +
                        (isSelected
                          ? "bg-[#0e1414] border-l-2 border-[#00ff95]"
                          : "hover:bg-[#0e1414] border-l-2 border-transparent")
                      }
                    >
                      <Server
                        size={12}
                        className={
                          isSelected
                            ? "text-[#00ff95] shrink-0"
                            : "text-[#5cc8ff] shrink-0"
                        }
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[#c9d1d9] font-mono text-sm truncate">
                          {h.name}
                        </div>
                        <div className="text-[#4a5560] font-mono text-xs truncate">
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
