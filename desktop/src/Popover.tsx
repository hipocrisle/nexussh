// Shared popover surface for ContextMenu + TabPicker. We only share the
// visual chrome (surface class + item / divider / section-label), NOT a
// backdrop wrapper: ContextMenu needs capture-phase outside-click so it works
// inside modals, and TabPicker needs the drag-aware useBackdropClose. Routing
// both through one naive onClick backdrop would regress those fixes.

import { ReactNode } from "react";

export const POPOVER_SURFACE =
  "bg-nx-panel border border-nx-border rounded-nx shadow-elev-2 py-1.5 font-mono select-none";

export function PopoverDivider() {
  return <div className="h-px bg-nx-divider my-1" />;
}

export function PopoverSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-micro uppercase tracking-[0.16em] text-nx-muted">
      // {children}
    </div>
  );
}

interface ItemProps {
  icon?: ReactNode;
  children: ReactNode;
  shortcut?: string;
  onClick?: () => void;
  destructive?: boolean;
  active?: boolean;
  disabled?: boolean;
}

export function PopoverItem({
  icon,
  children,
  shortcut,
  onClick,
  destructive,
  active,
  disabled,
}: ItemProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={
        "w-full grid grid-cols-[18px_1fr_auto] gap-2.5 items-center px-3 py-1.5 text-body text-left transition-colors duration-[80ms] " +
        (disabled
          ? "opacity-40 cursor-not-allowed "
          : "cursor-pointer ") +
        (destructive
          ? "text-nx-error hover:bg-[rgba(255,107,107,0.08)]"
          : active
            ? "bg-nx-elevated text-nx-accent"
            : "text-nx-text hover:bg-nx-elevated")
      }
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{children}</span>
      <span
        className={
          "text-meta tabular-nums " +
          (destructive ? "text-nx-error" : active ? "text-nx-accent" : "text-nx-muted")
        }
      >
        {shortcut}
      </span>
    </button>
  );
}
