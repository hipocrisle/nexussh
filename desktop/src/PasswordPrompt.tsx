// PasswordPrompt — themed, masked password dialog used when a host is set to
// "always ask password". Replaces window.prompt(), which renders an ugly native
// WebView dialog AND shows the typed password in plaintext (no masking).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { PasswordInput, Button } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  user: string;
  host: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordPrompt({ user, host, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    wrapRef.current?.querySelector("input")?.focus();
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
          onSubmit(pw);
        }}
        className="nx-modal-enter relative w-[420px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        <div className="flex items-center gap-2 mb-1 text-nx-accent font-mono">
          <KeyRound size={15} />
          <span className="text-lead">{t("app.password_title")}</span>
        </div>
        <div className="text-meta text-nx-muted font-mono mb-4">
          {user}
          <span className="text-nx-soft">@</span>
          {host}
        </div>
        <div ref={wrapRef}>
          <PasswordInput
            value={pw}
            onChange={setPw}
            placeholder={t("app.password_placeholder")}
          />
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("app.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("app.connect")}
          </Button>
        </div>
      </form>
    </div>
  );
}
