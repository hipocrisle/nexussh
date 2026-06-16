// ChoiceDialog — themed modal offering several mutually-exclusive options
// (plus cancel), for flows with >2 outcomes where a yes/no ConfirmDialog can't
// express the choice (e.g. "enable history as light OR full").

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

export interface ChoiceOption {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  title?: string;
  message: string;
  options: ChoiceOption[];
  cancelLabel?: string;
  onChoose: (value: string) => void;
  onCancel: () => void;
}

export function ChoiceDialog({
  title,
  message,
  options,
  cancelLabel,
  onChoose,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const optsRef = useRef<HTMLDivElement>(null);

  // Focus the first option as soon as the dialog opens so it's keyboard-ready —
  // no mouse click needed before arrows/Enter work.
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      optsRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      // Up/Down move focus between the option buttons.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const btns = Array.from(
          optsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        );
        if (btns.length === 0) return;
        e.preventDefault();
        const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = (cur + delta + btns.length) % btns.length;
        btns[next < 0 ? 0 : next].focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <div
        {...contentProps}
        className="nx-modal-enter relative w-[440px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        {title && (
          <div className="mb-2 font-mono text-lead text-nx-text">{title}</div>
        )}
        <div className="font-mono text-sm text-nx-muted mb-5 whitespace-pre-line">
          {message}
        </div>
        <div ref={optsRef} className="flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChoose(o.value)}
              className="nx-row text-left px-3.5 py-2.5 rounded-nx border border-nx-border bg-nx-elevated hover:border-nx-accent font-mono transition-colors"
            >
              <div className="text-sm text-nx-text">{o.label}</div>
              {o.hint && (
                <div className="text-meta text-nx-muted mt-0.5 whitespace-pre-line">
                  {o.hint}
                </div>
              )}
            </button>
          ))}
        </div>
        <div className="flex justify-end mt-4">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {cancelLabel ?? t("app.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
