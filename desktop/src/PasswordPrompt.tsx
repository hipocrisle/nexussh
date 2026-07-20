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
  /** Optional badge (e.g. "VPN") to distinguish a VPN-login prompt from the SSH
   *  password prompt that may follow it. */
  label?: string;
  onSubmit: (creds: { user: string; password: string }) => void;
  onCancel: () => void;
}

export function PasswordPrompt({ user, host, label, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const needLogin = !user;
  const [login, setLogin] = useState(user);
  const [pw, setPw] = useState("");
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const wrapRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const focusFirst = () =>
      wrapRef.current?.querySelector("input")?.focus();
    // Focus the first field — login if we're asking for it, else the password.
    focusFirst();
    // SECURITY focus trap. During a multi-host restore a saved-password host
    // connects in the background and its terminal grabs focus via a deferred
    // (double-rAF) term.focus() when it becomes visible — winning the race
    // against this dialog. If we let it, the password the user types lands in
    // that live terminal as CLEARTEXT (and is sent to the remote host). So we
    // (a) re-focus after the terminal's deferred grab, and (b) pull focus back
    // whenever anything steals it while this dialog is open.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(focusFirst),
    );
    const tid = window.setTimeout(focusFirst, 80);
    const onFocusOut = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (formRef.current && active && formRef.current.contains(active))
          return;
        focusFirst();
      });
    };
    const form = formRef.current;
    form?.addEventListener("focusout", onFocusOut);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(tid);
      form?.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("keydown", onKey);
    };
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
          {label && (
            <span className="text-micro font-mono px-1.5 py-0.5 rounded bg-nx-accent/15 text-nx-accent">
              {label}
            </span>
          )}
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
