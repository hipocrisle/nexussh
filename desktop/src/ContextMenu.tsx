// ContextMenu — small reusable right-click menu primitive.
// Renders a fixed-position panel at (x, y) with a list of items.
// Closes on outside click or Escape.

import { useEffect, useRef } from "react";

export interface MenuItem {
  /** Display label */
  label: string;
  /** Action — called when clicked, then menu closes. Omit for separators. */
  onClick?: () => void;
  /** Optional icon (lucide-react component, sized in container) */
  icon?: React.ReactNode;
  /** Marks the item as destructive (red text). */
  destructive?: boolean;
  /** Disabled state. */
  disabled?: boolean;
  /** Renders a separator line instead of an item when `separator` is true. */
  separator?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
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
  const W = 220;
  const H = items.length * 32 + 12;
  const safeX = Math.min(x, window.innerWidth - W - 8);
  const safeY = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={ref}
      className="fixed z-[9999] bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded shadow-xl py-1 font-mono text-xs select-none"
      style={{ left: safeX, top: safeY, minWidth: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div
            key={`sep-${i}`}
            className="my-1 h-px bg-[var(--nx-border)] mx-2"
          />
        ) : (
          <button
            key={`${i}-${it.label}`}
            onClick={() => {
              if (it.disabled) return;
              it.onClick?.();
              onClose();
            }}
            disabled={it.disabled}
            className={
              "w-full text-left px-3 py-1.5 flex items-center gap-2 " +
              (it.disabled
                ? "text-[var(--nx-text-muted)] cursor-not-allowed"
                : it.destructive
                  ? "text-[var(--nx-error)] hover:bg-[var(--nx-border)]"
                  : "text-[var(--nx-text-primary)] hover:bg-[var(--nx-border)] hover:text-[var(--nx-accent)]")
            }
          >
            {it.icon && <span className="shrink-0">{it.icon}</span>}
            <span className="truncate">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
