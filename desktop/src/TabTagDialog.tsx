// TabTagDialog — set a workspace tab's tag (transient title) and a soft accent
// color. Lives only as long as the tab: neither is written to the host record
// or synced; the tab strip renders the color as a faint bg + thin outline so
// same-host tabs (four × DE-1) stay tell-apart at a glance.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button, Input } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

// Muted accents that sit well on the dark tab strip. Rendered with low alpha
// (bg ~8%, outline ~35%) so the mark stays a hint, not a beacon.
export const TAB_TAG_COLORS = [
  "#00d4ff", // cyan
  "#00ff95", // green
  "#f5d76e", // yellow
  "#ffb86b", // orange
  "#ff6b6b", // red
  "#c792ea", // violet
  "#7fd7ff", // soft blue
  "#ff8fb1", // pink
];

interface Props {
  initialTitle: string;
  initialColor?: string;
  onSubmit: (title: string, color: string | null) => void;
  onCancel: () => void;
}

export function TabTagDialog({ initialTitle, initialColor, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialTitle);
  const [color, setColor] = useState<string | null>(initialColor ?? null);
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <form
        {...contentProps}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value, color);
        }}
        className="nx-modal-enter relative w-[440px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        <div className="text-lead text-nx-text font-mono mb-2">{t("tabtag.title")}</div>
        <div className="font-mono text-sm text-nx-muted mb-3 whitespace-pre-line">
          {t("tabtag.prompt")}
        </div>
        <Input
          ref={inputRef}
          value={value}
          onChange={setValue}
          placeholder={t("tabtag.placeholder")}
        />
        <div className="mt-4">
          <div className="text-micro uppercase tracking-[0.12em] text-nx-soft mb-2">
            {t("tabtag.color_label")}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              title={t("tabtag.color_none")}
              onClick={() => setColor(null)}
              className={
                "nx-focus w-5 h-5 rounded-full inline-flex items-center justify-center border transition-colors " +
                (color === null
                  ? "border-nx-accent text-nx-accent"
                  : "border-nx-border text-nx-muted hover:border-nx-text hover:text-nx-text")
              }
            >
              <X size={11} />
            </button>
            {TAB_TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={
                  "nx-focus w-5 h-5 rounded-full transition-all " +
                  (color === c ? "ring-2 ring-nx-text ring-offset-2 ring-offset-nx-panel" : "")
                }
                style={{ background: c, opacity: color === c ? 1 : 0.75 }}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("app.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("confirm.ok")}
          </Button>
        </div>
      </form>
    </div>
  );
}
