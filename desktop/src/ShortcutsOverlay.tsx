// Keyboard shortcut reference. Triggered by `?` / `Ctrl+/`. Source of truth
// for what bindings actually exist — kept in sync with the handler in App.tsx
// by code-review only (no runtime registry yet).

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useBackdropClose } from "./useBackdropClose";

interface Section {
  title: string;
  items: { keys: string[]; desc: string }[];
}

interface Props {
  onClose: () => void;
}

export function ShortcutsOverlay({ onClose }: Props) {
  const { t } = useTranslation();
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections: Section[] = [
    {
      title: t("shortcuts.s_tabs"),
      items: [
        { keys: ["Ctrl", "T"], desc: t("shortcuts.k_tab_picker") },
        { keys: ["Ctrl", "W"], desc: t("shortcuts.k_close_pane") },
        { keys: ["Ctrl", "Tab"], desc: t("shortcuts.k_cycle_tabs") },
        { keys: ["Ctrl", "Shift", "Tab"], desc: t("shortcuts.k_cycle_tabs_back") },
        { keys: ["Ctrl", "Shift", "T"], desc: t("shortcuts.k_restore_tab") },
        { keys: ["Ctrl", "1…9"], desc: t("shortcuts.k_jump_tab") },
        { keys: ["Ctrl", "Shift", "PgUp/PgDn"], desc: t("shortcuts.k_move_tab") },
      ],
    },
    {
      title: t("shortcuts.s_splits"),
      items: [
        { keys: ["Ctrl", "Shift", "D"], desc: t("shortcuts.k_split_right") },
        { keys: ["Ctrl", "Shift", "E"], desc: t("shortcuts.k_split_down") },
      ],
    },
    {
      title: t("shortcuts.s_chrome"),
      items: [
        { keys: ["Ctrl", ","], desc: t("shortcuts.k_settings") },
        { keys: ["Ctrl", "Shift", "L"], desc: t("shortcuts.k_lock") },
        { keys: ["?"], desc: t("shortcuts.k_this_overlay") },
        { keys: ["Ctrl", "/"], desc: t("shortcuts.k_this_overlay") },
        { keys: ["Esc"], desc: t("shortcuts.k_close_overlay") },
      ],
    },
    {
      title: t("shortcuts.s_terminal"),
      items: [
        { keys: ["Ctrl", "Shift", "C"], desc: t("shortcuts.k_copy") },
        { keys: ["Ctrl", "Shift", "V"], desc: t("shortcuts.k_paste") },
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[10vh] max-md:pt-0 max-md:bg-nx-bg max-md:backdrop-blur-none"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="nx-modal-enter w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col bg-nx-bg-2 border border-nx-border rounded-nx shadow-2xl max-md:max-w-none max-md:max-h-none max-md:h-full max-md:rounded-none max-md:border-0"
      >
        <div className="nx-safe-top flex items-center gap-2.5 px-4 py-3 border-b border-nx-divider">
          <span className="text-nx-accent">&gt;</span>
          <span className="text-lead text-nx-text font-mono">
            {t("shortcuts.title")}
          </span>
          <button
            onClick={onClose}
            aria-label={t("shortcuts.close")}
            className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-nx-sm border border-nx-border bg-nx-panel text-nx-text hover:bg-nx-elevated active:bg-nx-bg-2"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-5 font-mono">
          {sections.map((s) => (
            <section key={s.title}>
              <div className="text-micro uppercase tracking-wider text-nx-soft mb-2">
                // {s.title}
              </div>
              <ul className="space-y-1.5">
                {s.items.map((it, i) => (
                  <li
                    key={i}
                    className="grid grid-cols-[auto_1fr] gap-3 items-center text-meta"
                  >
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      {it.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="px-1.5 py-0.5 border border-nx-border rounded-nx-sm bg-nx-panel text-nx-accent text-micro"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-nx-text">{it.desc}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
