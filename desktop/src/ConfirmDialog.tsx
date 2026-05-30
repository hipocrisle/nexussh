// ConfirmDialog — themed yes/no modal replacing the native window.confirm() and
// Tauri ask() dialogs, both of which render as ugly white WebView2 popups that
// jar against the rest of the app.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <div
        {...contentProps}
        className="nx-modal-enter relative w-[440px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        <div className="flex items-center gap-2 mb-2 font-mono">
          <AlertTriangle size={15} className="text-nx-warning" />
          <span className="text-lead text-nx-text">
            {title ?? t("confirm.title")}
          </span>
        </div>
        <div className="font-mono text-sm text-nx-muted mb-5 whitespace-pre-line">
          {message}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {cancelLabel ?? t("app.cancel")}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={destructive ? "destructive" : "primary"}
            onClick={onConfirm}
          >
            {confirmLabel ?? t("confirm.ok")}
          </Button>
        </div>
      </div>
    </div>
  );
}
