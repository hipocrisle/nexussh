// PaneHeader — mini-toolbar shown above each pane when the workspace has ≥2
// panes. Makes split panes legible: focus stripe on the left, host name +
// status dot, ⋮ menu, × close. The whole header is a drag handle (parent
// hooks into onPointerDown to start a pane drag).

import { GripVertical, MoreVertical, X as CloseIcon } from "lucide-react";

interface Props {
  hostLabel: string;
  status: "connecting" | "connected" | "closed";
  focused: boolean;
  onClick: () => void; // focus the pane
  onClose: () => void;
  onMenu: (x: number, y: number) => void;
  onDragStart: (e: React.PointerEvent) => void;
}

export function PaneHeader({
  hostLabel,
  status,
  focused,
  onClick,
  onClose,
  onMenu,
  onDragStart,
}: Props) {
  const dotColor =
    status === "connected"
      ? "var(--nx-accent)"
      : status === "connecting"
        ? "var(--nx-warning)"
        : "var(--nx-text-muted)";
  return (
    <div
      onPointerDown={onDragStart}
      onClick={onClick}
      className="select-none h-6 flex items-center text-meta font-mono border-b cursor-pointer"
      style={{
        background: focused ? "var(--nx-bg-panel)" : "var(--nx-bg-secondary)",
        borderColor: "var(--nx-border)",
        color: focused ? "var(--nx-text-primary)" : "var(--nx-text-muted)",
      }}
      title={hostLabel}
    >
      {/* focus stripe */}
      <span
        className="self-stretch w-[3px] shrink-0"
        style={{ background: focused ? "var(--nx-accent)" : "transparent" }}
      />
      {/* drag-grip glyph (visual hint) */}
      <span className="px-1 opacity-50 hover:opacity-100">
        <GripVertical size={12} />
      </span>
      {/* status dot */}
      <span
        className={
          "inline-block w-1.5 h-1.5 rounded-full shrink-0 mr-1.5 " +
          (status === "connecting" ? "nx-pulse" : "")
        }
        style={{ background: dotColor }}
      />
      <span className="truncate flex-1 min-w-0 pr-2">{hostLabel}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="px-1.5 h-full opacity-60 hover:opacity-100 hover:text-nx-text"
        title="…"
      >
        <MoreVertical size={12} />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="px-1.5 h-full opacity-60 hover:opacity-100 hover:text-nx-error"
        title="×"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
