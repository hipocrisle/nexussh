// Sidebar — host list, search, add button.

import { useEffect, useState, useMemo } from "react";
import { Plus, Search, Server, Pencil, Trash2 } from "lucide-react";
import { HostRecord, listHosts, deleteHost } from "./hosts";
import { HostDialog } from "./HostDialog";

interface Props {
  onConnect: (h: HostRecord) => void;
}

export function Sidebar({ onConnect }: Props) {
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "edit"; rec: HostRecord } | null>(null);

  const reload = async () => setHosts(await listHosts());

  useEffect(() => {
    reload();
  }, []);

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

  const groups = useMemo(() => {
    const m = new Map<string, HostRecord[]>();
    for (const h of filtered) {
      const g = h.group ?? "—";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(h);
    }
    // Sort hosts inside each group by lastUsedAt desc, then name
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
  }, [filtered]);

  async function remove(h: HostRecord) {
    if (!confirm(`Удалить ${h.name}?`)) return;
    await deleteHost(h.id);
    reload();
  }

  return (
    <aside className="w-64 h-full bg-[#080b0b] border-r border-[#1f3a3a] flex flex-col">
      <div className="p-3 border-b border-[#1f3a3a] flex gap-2 items-center">
        <Search size={14} className="text-[#4a5560]" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter..."
          className="flex-1 bg-transparent text-[#c9d1d9] placeholder-[#4a5560] font-mono text-sm focus:outline-none"
        />
        <button
          onClick={() => setDialog({ kind: "add" })}
          title="Add host"
          className="text-[#00ff95] hover:text-[#5fffb4]"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <div className="text-center text-[#4a5560] font-mono text-xs p-6">
            no hosts yet
            <br />
            <button
              onClick={() => setDialog({ kind: "add" })}
              className="mt-2 text-[#00ff95] hover:text-[#5fffb4] underline"
            >
              + add the first one
            </button>
          </div>
        )}

        {groups.map(([g, list]) => (
          <div key={g} className="mb-2">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#4a5560] font-mono">
              {g}
            </div>
            {list.map((h) => (
              <div
                key={h.id}
                className="group px-3 py-1.5 flex items-center gap-2 hover:bg-[#0e1414] cursor-pointer"
                onClick={() => onConnect(h)}
              >
                <Server size={12} className="text-[#5cc8ff] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[#c9d1d9] font-mono text-sm truncate">
                    {h.name}
                  </div>
                  <div className="text-[#4a5560] font-mono text-xs truncate">
                    {h.user}@{h.host}:{h.port}
                  </div>
                </div>
                <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDialog({ kind: "edit", rec: h });
                    }}
                    className="text-[#7fd7ff] hover:text-[#00ff95]"
                    title="Edit"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(h);
                    }}
                    className="text-[#ff6b6b]/70 hover:text-[#ff6b6b]"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {dialog?.kind === "add" && (
        <HostDialog
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
