// TabBar — horizontal list of open terminal tabs + `+` to open a new tab.
// Right-click on a tab opens a context menu (rename / restart / close).

import { X, Loader2, Wifi, WifiOff, Plus } from "lucide-react";

export interface TabInfo {
  id: string; // session_id from backend
  title: string;
  status: "connecting" | "connected" | "closed";
}

interface Props {
  tabs: TabInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  /** Right-click handler — parent draws the context menu. */
  onContextMenu?: (id: string, x: number, y: number) => void;
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTab,
  onContextMenu,
}: Props) {
  return (
    <div className="h-9 flex items-center bg-[var(--nx-bg-secondary)] border-b border-[var(--nx-border)]">
      <div className="flex-1 min-w-0 overflow-x-auto flex items-center h-full">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu?.(t.id, e.clientX, e.clientY);
              }}
              className={
                "h-full px-3 flex items-center gap-2 cursor-pointer border-r border-[var(--nx-border)] min-w-0 shrink-0 " +
                (active
                  ? "bg-[var(--nx-bg-base)] text-[var(--nx-accent)]"
                  : "text-[var(--nx-text-primary)] hover:bg-[var(--nx-bg-panel)]")
              }
            >
              {t.status === "connecting" && (
                <Loader2 size={12} className="animate-spin text-[var(--nx-warning)]" />
              )}
              {t.status === "connected" && (
                <Wifi size={12} className="text-[var(--nx-accent)]" />
              )}
              {t.status === "closed" && (
                <WifiOff size={12} className="text-[var(--nx-error)]/70" />
              )}
              <span className="font-mono text-sm truncate max-w-[180px]">
                {t.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className="opacity-50 hover:opacity-100 hover:text-[var(--nx-error)]"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={onNewTab}
        title="New tab — Ctrl+T"
        className="h-full shrink-0 px-3 flex items-center text-[var(--nx-text-soft)] hover:bg-[var(--nx-bg-panel)] hover:text-[var(--nx-accent)] border-l border-[var(--nx-border)]"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
