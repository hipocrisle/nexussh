// ContextMenu — small reusable right-click menu primitive.
// Renders a fixed-position panel at (x, y) with a list of items.
// Closes on outside click or Escape. Shares its visual surface with
// TabPicker via Popover.tsx.

import { useEffect, useRef } from "react";
import {
  POPOVER_SURFACE,
  PopoverItem,
  PopoverDivider,
  PopoverSectionLabel,
} from "./Popover";

export interface MenuItem {
  /** Display label */
  label: string;
  /** Action — called when clicked, then menu closes. Omit for separators. */
  onClick?: () => void;
  /** Optional icon (lucide-react component, sized in container) */
  icon?: React.ReactNode;
  /** Optional right-aligned shortcut hint (e.g. "⌘D", "↵"). */
  shortcut?: string;
  /** Marks the item as destructive (red text). */
  destructive?: boolean;
  /** Disabled state. */
  disabled?: boolean;
  /** Renders a separator line instead of an item when `separator` is true. */
  separator?: boolean;
  /** Renders a "// section" label instead of an item. */
  sectionLabel?: string;
  /** Renders with the active accent treatment (e.g. current folder). */
  checked?: boolean;
}

interface Props {
  x: number;
  y: number;
  /** Optional header — kicker + main line shown above the items. */
  title?: { kicker?: string; main?: string };
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture phase: modals using useBackdropClose stopPropagation on
    // mousedown to protect their backdrop-close logic, which would otherwise
    // swallow this bubble-phase listener and leave the menu stuck open.
    document.addEventListener("mousedown", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp to viewport
  const W = 240;
  const H = items.length * 32 + (title ? 48 : 0) + 16;
  const safeX = Math.min(x, window.innerWidth - W - 8);
  const safeY = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={ref}
      className={"fixed z-[9999] " + POPOVER_SURFACE}
      style={{ left: safeX, top: safeY, minWidth: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && (
        <>
          <div className="px-3 pt-1.5 pb-1.5">
            {title.kicker && (
              <div className="text-micro uppercase tracking-[0.16em] text-nx-muted">
                // {title.kicker}
              </div>
            )}
            {title.main && (
              <div className="text-body text-nx-text mt-0.5 truncate">{title.main}</div>
            )}
          </div>
          <PopoverDivider />
        </>
      )}
      {items.map((it, i) => {
        if (it.separator) return <PopoverDivider key={`sep-${i}`} />;
        if (it.sectionLabel)
          return <PopoverSectionLabel key={`sec-${i}`}>{it.sectionLabel}</PopoverSectionLabel>;
        return (
          <PopoverItem
            key={`${i}-${it.label}`}
            icon={it.icon}
            shortcut={it.shortcut}
            destructive={it.destructive}
            active={it.checked}
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </PopoverItem>
        );
      })}
    </div>
  );
}
