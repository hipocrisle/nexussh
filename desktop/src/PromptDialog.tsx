// PromptDialog — themed text-input modal replacing window.prompt(). The
// natively-rendered prompt() is a white WebView2 popup with no theme support
// and a "tauri.localhost says" header.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  message: string;
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  message,
  title,
  placeholder,
  defaultValue,
  confirmLabel,
  cancelLabel,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue ?? "");
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const inputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.querySelector("input")?.focus();
    inputRef.current?.querySelector("input")?.select();
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
          onSubmit(value);
        }}
        className="nx-modal-enter relative w-[440px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        {title && (
          <div className="text-lead text-nx-text font-mono mb-2">{title}</div>
        )}
        <div className="font-mono text-sm text-nx-muted mb-3 whitespace-pre-line">
          {message}
        </div>
        <div ref={inputRef}>
          <Input value={value} onChange={setValue} placeholder={placeholder} />
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {cancelLabel ?? t("app.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {confirmLabel ?? t("confirm.ok")}
          </Button>
        </div>
      </form>
    </div>
  );
}
