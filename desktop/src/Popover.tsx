// Shared popover surface for ContextMenu + TabPicker + Select. We only share the
// visual chrome (surface class + item / divider / section-label), NOT a
// backdrop wrapper: ContextMenu needs capture-phase outside-click so it works
// inside modals, and TabPicker needs the drag-aware useBackdropClose. Routing
// both through one naive onClick backdrop would regress those fixes.
//
// Item visual (design handoff step 9): icon · label (+ optional trailing chip),
// accent left-bar on hover/active, icon turns accent on hover, danger = error
// red. NO keyboard-shortcut column (shortcuts live in the Shortcuts window).

import { ReactNode } from "react";

export const POPOVER_SURFACE =
  "bg-nx-panel border border-nx-border rounded-[7px] py-[5px] font-mono select-none " +
  "shadow-[inset_0_1px_0_rgba(0,255,149,0.06),0_16px_44px_rgba(0,0,0,0.6)]";

export function PopoverDivider() {
  return <div className="h-px bg-nx-divider my-[5px]" />;
}

export function PopoverSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-[13px] pt-2 pb-1 text-[9px] uppercase tracking-[0.18em] text-nx-muted">
      // {children}
    </div>
  );
}

interface ItemProps {
  icon?: ReactNode;
  children: ReactNode;
  /** Optional right-aligned trailing element (e.g. a folder country-code chip). */
  trailing?: ReactNode;
  onClick?: () => void;
  destructive?: boolean;
  active?: boolean;
  disabled?: boolean;
}

export function PopoverItem({
  icon,
  children,
  trailing,
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
      className={[
        "group relative w-full grid grid-cols-[18px_1fr_auto] gap-[11px] items-center",
        "px-[13px] py-[7px] text-left text-[12.5px] transition-colors duration-[70ms]",
        // Finger-sized rows on mobile (the dense desktop rows were hard to tap).
        "max-md:py-3 max-md:px-4 max-md:text-[15px] max-md:gap-3",
        disabled
          ? "text-nx-muted opacity-45 cursor-not-allowed"
          : destructive
            ? "text-nx-error hover:bg-[rgba(255,107,107,0.08)] cursor-pointer"
            : active
              ? "text-nx-accent bg-nx-elevated cursor-pointer"
              : "text-nx-text hover:bg-nx-elevated cursor-pointer",
      ].join(" ")}
    >
      {/* accent left-bar on hover/active (not for disabled) */}
      {!disabled && (
        <span
          className={[
            "absolute left-0 top-[3px] bottom-[3px] w-[2px] rounded-r-[2px] transition-opacity",
            destructive
              ? "bg-nx-error shadow-[0_0_8px_rgba(255,107,107,0.3)]"
              : "bg-nx-accent shadow-[0_0_8px_var(--nx-accent-glow)]",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          ].join(" ")}
        />
      )}
      <span
        className={[
          "inline-flex shrink-0",
          destructive
            ? "text-nx-error"
            : active
              ? "text-nx-accent"
              : "text-nx-muted group-hover:text-nx-accent",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="truncate">{children}</span>
      {trailing}
    </button>
  );
}
