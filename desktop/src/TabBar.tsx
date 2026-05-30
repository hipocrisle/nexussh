// TabBar — horizontal list of open terminal tabs + `+` to open a new tab.
// Right-click on a tab opens a context menu (rename / restart / close).

import { useEffect, useRef, useState } from "react";
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
  /** Drag-reorder: move `fromId` to before/after `toId`. */
  onReorder?: (fromId: string, toId: string, before: boolean) => void;
  /** Fired during a tab drag (after the threshold) — lets the parent show
   *  drag-to-edge split affordances. */
  onDragMove?: (tabId: string, x: number, y: number) => void;
  /** Fired when a tab drag ends — parent decides edge-split, etc. */
  onDragEnd?: (tabId: string, x: number, y: number) => void;
  /** Fired when a drag is aborted (window lost focus, button released outside
   *  the page). Lets the parent clear any preview overlays without splitting. */
  onDragCancel?: (tabId: string) => void;
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
  onReorder,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    before: boolean;
  } | null>(null);
  // Set on drag-start, read by the click handler to swallow the click that
  // fires at the end of a drag (so reordering never selects by accident).
  const dragRef = useRef<{ id: string; startX: number; started: boolean } | null>(
    null,
  );

  function onTabMouseDown(e: React.MouseEvent, id: string) {
    if (e.button !== 0) return;
    dragRef.current = { id, startX: e.clientX, started: false };
  }

  useEffect(() => {
    // Resets local drag state without firing a drop. Used when the user aborts
    // — released the mouse outside the page, alt-tabbed, etc.
    const cancel = (id?: string) => {
      dragRef.current = null;
      setDragId(null);
      setDropTarget(null);
      document.body.style.cursor = "";
      if (id) onDragCancel?.(id);
    };
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // If no buttons are pressed but a drag is in progress, the user released
      // outside the window. Treat as cancel — don't accidentally split on the
      // next click. e.buttons is 0 only when no button is being held.
      if (d.started && e.buttons === 0) {
        cancel(d.id);
        return;
      }
      if (!d.started && Math.abs(e.clientX - d.startX) > 5) {
        d.started = true;
        setDragId(d.id);
        document.body.style.cursor = "grabbing";
      }
      if (!d.started) return;
      onDragMove?.(d.id, e.clientX, e.clientY);
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const tabEl = el?.closest("[data-tab-id]") as HTMLElement | null;
      const id = tabEl?.dataset.tabId;
      if (id && id !== d.id) {
        const r = tabEl!.getBoundingClientRect();
        setDropTarget({ id, before: e.clientX < r.left + r.width / 2 });
      } else {
        setDropTarget(null);
      }
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      document.body.style.cursor = "";
      if (d?.started) {
        // A tab was under the cursor → reorder/cross-pane move; otherwise let
        // the parent decide (e.g. drag-to-edge split).
        if (dropTarget) onReorder?.(d.id, dropTarget.id, dropTarget.before);
        else onDragEnd?.(d.id, e.clientX, e.clientY);
      }
      setDragId(null);
      setDropTarget(null);
    };
    const onWindowBlur = () => {
      const d = dragRef.current;
      if (d?.started) cancel(d.id);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [dropTarget, onReorder, onDragMove, onDragEnd, onDragCancel]);

  return (
    <div className="h-9 flex items-center bg-nx-bg-2 border-b border-nx-border shrink-0">
      <div className="min-w-0 overflow-x-auto overflow-y-hidden flex items-center h-full">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              data-tab-id={t.id}
              data-active={active || undefined}
              onMouseDown={(e) => onTabMouseDown(e, t.id)}
              onClick={() => {
                if (dragId) return; // swallow click at end of a drag
                onSelect(t.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu?.(t.id, e.clientX, e.clientY);
              }}
              style={
                dropTarget?.id === t.id
                  ? {
                      boxShadow: dropTarget.before
                        ? "inset 2px 0 0 var(--nx-accent)"
                        : "inset -2px 0 0 var(--nx-accent)",
                    }
                  : dragId === t.id
                    ? { opacity: 0.5 }
                    : undefined
              }
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
