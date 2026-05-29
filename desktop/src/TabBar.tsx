// TabBar — horizontal list of open terminal tabs + `+` to open a new tab.
// Right-click on a tab opens a context menu (rename / restart / close).

import { X, Plus, ChevronDown } from "lucide-react";

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
  /** Caret next to + — parent opens the connection-type menu at (x, y). */
  onNewTabDropdown?: (x: number, y: number) => void;
  /** Right-click handler — parent draws the context menu. */
  onContextMenu?: (id: string, x: number, y: number) => void;
}

function StatusDot({ status }: { status: TabInfo["status"] }) {
  const map = {
    connected: { color: "var(--nx-accent)", pulse: false, shadow: "0 0 8px var(--nx-accent-glow)" },
    connecting: { color: "var(--nx-warning)", pulse: true, shadow: "none" },
    closed: { color: "var(--nx-text-muted)", pulse: false, shadow: "none" },
  }[status];
  return (
    <span
      className={"inline-block w-1.5 h-1.5 rounded-full shrink-0 " + (map.pulse ? "nx-pulse" : "")}
      style={{ background: map.color, boxShadow: map.shadow, color: map.color }}
    />
  );
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTab,
  onNewTabDropdown,
  onContextMenu,
}: Props) {
  return (
    <div className="h-9 flex items-center bg-nx-bg-2 border-b border-nx-border shrink-0">
      <div className="min-w-0 overflow-x-auto overflow-y-hidden flex items-center h-full">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              data-active={active || undefined}
              onClick={() => onSelect(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu?.(t.id, e.clientX, e.clientY);
              }}
              className={
                "nx-tab h-full px-3 flex items-center gap-2 cursor-pointer border-r border-nx-border min-w-0 shrink-0 " +
                (active
                  ? "bg-nx-panel text-nx-text"
                  : "text-nx-muted hover:bg-nx-elevated hover:text-nx-text")
              }
            >
              <StatusDot status={t.status} />
              <span
                className={
                  "font-mono text-body truncate max-w-[180px] " +
                  (t.status === "closed" ? "line-through opacity-70" : "")
                }
              >
                {t.title}
              </span>
              <X
                size={12}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className="ml-1 opacity-50 hover:opacity-100 hover:text-nx-error"
              />
            </button>
          );
        })}
      </div>
      <button
        onClick={onNewTab}
        title="New tab — Ctrl+T"
        className="h-full shrink-0 pl-2.5 pr-1.5 flex items-center text-nx-accent hover:bg-nx-elevated transition-colors duration-[80ms]"
      >
        <Plus size={14} />
      </button>
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onNewTabDropdown?.(r.left, r.bottom);
        }}
        title="New tab type"
        className="h-full shrink-0 pr-2 pl-0.5 flex items-center text-nx-muted hover:bg-nx-elevated hover:text-nx-accent transition-colors duration-[80ms]"
      >
        <ChevronDown size={12} />
      </button>
      {/* Draggable filler — empty tab-strip space moves the window, browser-style */}
      <div data-tauri-drag-region className="flex-1 h-full" />
    </div>
  );
}
