// PasswordPrompt — themed, masked credential dialog used when a host is set to
// "always ask password". Replaces window.prompt(). When the host has NO login
// (e.g. an address-only host imported from a shared bundle) it ALSO asks for the
// username, like quick-connect — so shared host lists work without baking in
// anyone's login.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { Input, PasswordInput, Button } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  user: string;
  host: string;
  onSubmit: (creds: { user: string; password: string }) => void;
  onCancel: () => void;
}

export function PasswordPrompt({ user, host, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const needLogin = !user;
  const [login, setLogin] = useState(user);
  const [pw, setPw] = useState("");
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus the first field — login if we're asking for it, else the password.
    wrapRef.current?.querySelector("input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function submit() {
    const u = (needLogin ? login.trim() : user) || login.trim();
    onSubmit({ user: u, password: pw });
  }

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <form
        {...contentProps}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="nx-modal-enter relative w-[420px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        <div className="flex items-center gap-2 mb-1 text-nx-accent font-mono">
          <KeyRound size={15} />
          <span className="text-lead">{t("app.password_title")}</span>
        </div>
        <div className="text-meta text-nx-muted font-mono mb-4">
          {needLogin ? (
            host
          ) : (
            <>
              {user}
              <span className="text-nx-soft">@</span>
              {host}
            </>
          )}
        </div>
        <div ref={wrapRef} className="space-y-3">
          {needLogin && (
            <Input
              value={login}
              onChange={setLogin}
              placeholder={t("quick.login")}
            />
          )}
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
