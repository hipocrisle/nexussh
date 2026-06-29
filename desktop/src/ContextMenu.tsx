// ContextMenu — small reusable right-click menu primitive.
// Renders a fixed-position panel at (x, y) with a list of items.
// Closes on outside click or Escape. Shares its visual surface with
// TabPicker via Popover.tsx.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  /** Optional right-aligned trailing element (e.g. a folder country-code chip).
   *  No keyboard-shortcut hints in menus (they live in the Shortcuts window). */
  trailing?: React.ReactNode;
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
  /** Optional header — kicker + main line (+ sub) shown above the items. */
  title?: { kicker?: string; main?: React.ReactNode; sub?: React.ReactNode };
  items: MenuItem[];
  width?: number;
  onClose: () => void;
}

export function ContextMenu({ x, y, title, items, width = 264, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Measure the REAL rendered size and clamp into the viewport. Height estimates
  // under-counted (title card + section labels + tall touch rows) → the last item
  // ("Delete") went offscreen on mobile. Real measurement flips the menu up fully.
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, items, title]);

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

  // Position (pos) is measured & clamped in useLayoutEffect above. Initial render
  // uses the raw (x,y); the layout effect repositions synchronously before paint.
  const W = width;

  return (
    <div
      ref={ref}
      className={"fixed z-[9999] " + POPOVER_SURFACE}
      style={{ left: pos.left, top: pos.top, minWidth: W, maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}
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
              <div className="text-[12px] text-nx-soft mt-[3px] truncate">{title.main}</div>
            )}
            {title.sub && (
              <div className="text-[11px] text-nx-muted mt-[1px] truncate">{title.sub}</div>
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
            trailing={it.trailing}
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
