// Select — custom dropdown replacing native <select>.
//
// Why this exists: on Linux/WebKitGTK the native <select> popup is painted by
// GTK with the system (white) background, ignoring our CSS on <option>. The
// closed control darkens, the open list does not — so it clashes badly with
// the dark theme. The only reliable fix is a DOM-rendered dropdown.
//
// Outside-click + Esc: we reuse ContextMenu's capture-phase approach. These
// dropdowns live INSIDE modals (HostDialog, SyncPanel) whose useBackdropClose
// stopPropagation's mousedown on the content; a bubble-phase listener would be
// swallowed and the list would stay stuck open. Capture phase sidesteps that.

import { ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { POPOVER_SURFACE, PopoverItem } from "./Popover";

export interface SelectOption {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Don't let the modal's own Esc handler also fire and close it.
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Capture phase: see header note — modal backdrops swallow bubble-phase.
    document.addEventListener("mousedown", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={"relative " + (className ?? "")}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
        className={
          "nx-focus w-full flex items-center gap-2 px-2.5 py-1.5 bg-nx-panel border border-nx-border rounded-nx font-mono text-body text-nx-text " +
          (disabled ? "opacity-40 cursor-not-allowed " : "cursor-pointer ")
        }
      >
        <span className="flex-1 min-w-0 flex items-center gap-2 text-left truncate">
          {selected ? (
            <>
              {selected.icon && <span className="shrink-0">{selected.icon}</span>}
              <span className="truncate">{selected.label}</span>
            </>
          ) : (
            <span className="truncate text-nx-muted">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          size={14}
          className={
            "shrink-0 text-nx-muted transition-transform duration-[120ms] " +
            (open ? "rotate-180" : "")
          }
        />
      </button>

      {open && (
        <div
          className={
            "absolute left-0 right-0 mt-1 z-50 max-h-[240px] overflow-auto " +
            POPOVER_SURFACE
          }
        >
          {options.map((o) => (
            <PopoverItem
              key={o.value}
              icon={o.icon}
              active={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </PopoverItem>
          ))}
        </div>
      )}
    </div>
  );
}
