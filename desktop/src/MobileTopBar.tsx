// Mobile top app bar — Material 3-style strip: hamburger | title | overflow.
// 56dp tall (matches Android Material guideline), respects safe-area-inset-top
// so the system status bar doesn't paint over it.
//
// Replaces the desktop chrome (brand mark, prompt breadcrumb, History/Sync/
// Vault/Help/Language/WindowControls bar) on phones. All those actions live
// in the ⋮ overflow menu instead.

import { useState, useRef, useEffect } from "react";
import { Menu as MenuIcon, MoreVertical } from "lucide-react";
import { useTranslation } from "react-i18next";

interface OverflowItem {
  label: string;
  onClick: () => void;
  warn?: boolean;
  active?: boolean;
}

interface Props {
  title: string;
  subtitle?: string;
  onDrawer: () => void;
  items: OverflowItem[];
}

export function MobileTopBar({ title, subtitle, onDrawer, items }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header
      className="nx-safe-top relative z-20 bg-nx-bg-2 border-b border-nx-border shrink-0"
    >
      <div className="h-14 px-3 flex items-center gap-2 select-none">
        <button
          onClick={onDrawer}
          aria-label={t("sidebar.toggle")}
          className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-text"
        >
          <MenuIcon size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="truncate font-mono text-nx-text text-lead">
            {title}
          </div>
          {subtitle && (
            <div className="truncate font-mono text-nx-muted text-meta -mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
        {items.length > 0 && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label={t("topbar.more")}
              className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-text"
            >
              <MoreVertical size={20} />
            </button>
            {open && (
              <div className="absolute right-0 top-12 min-w-[180px] bg-nx-bg-2 border border-nx-border rounded-nx-sm shadow-2xl py-1 z-30">
                {items.map((it, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setOpen(false);
                      it.onClick();
                    }}
                    className={
                      "w-full text-left px-4 py-3 font-mono text-lead active:bg-nx-elevated " +
                      (it.warn
                        ? "text-nx-warning"
                        : it.active
                          ? "text-nx-accent"
                          : "text-nx-text")
                    }
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
