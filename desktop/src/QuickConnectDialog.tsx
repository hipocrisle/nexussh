// QuickConnectDialog — PuTTY-style. After the user types just an IP[:port] in
// the tab picker and hits Enter, this asks for the login + password (which
// PuTTY prompts for after "Open"), then connects a one-off session that isn't
// saved to the host list.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";
import { Input, PasswordInput, Button } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  host: string;
  port: number;
  defaultUser: string;
  onSubmit: (creds: { user: string; password: string }) => void;
  onCancel: () => void;
}

export function QuickConnectDialog({
  host,
  port,
  defaultUser,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [user, setUser] = useState(defaultUser);
  const [pw, setPw] = useState("");
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const loginRef = useRef<HTMLInputElement>(null);
  // The same Enter that opened this dialog (from the picker's host field) must
  // NOT auto-submit it — otherwise quick connect silently fires as the default
  // user with an empty password. Ignore submits until armed a tick later.
  const armed = useRef(false);
  // onCancel is an inline arrow in the parent (new identity every render); keep
  // it in a ref so the mount-only effect below never needs it as a dependency.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // MOUNT ONLY. Previously this depended on [onCancel], so it re-ran on every
  // parent render and re-focused+`select()`ed the login field — which kept
  // re-selecting the text mid-typing, making login/password impossible to enter.
  useEffect(() => {
    // Focus the login so the default user is visible and editable (select it so
    // typing replaces it), instead of jumping past it to the password.
    loginRef.current?.focus();
    loginRef.current?.select();
    const armTimer = window.setTimeout(() => {
      armed.current = true;
    }, 200);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(armTimer);
    };
  }, []);

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <form
        {...contentProps}
        onSubmit={(e) => {
          e.preventDefault();
          if (!armed.current) return; // swallow the Enter that opened the dialog
          onSubmit({ user: user.trim() || defaultUser, password: pw });
        }}
        className="nx-modal-enter relative w-[420px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        <div className="flex items-center gap-2 mb-1 text-nx-accent font-mono">
          <Zap size={15} />
          <span className="text-lead">{t("quick.title")}</span>
        </div>
        <div className="text-meta text-nx-muted font-mono mb-4">
          {host}
          <span className="text-nx-soft">:</span>
          {port}
        </div>

        <label className="text-meta text-nx-soft font-mono">
          {t("quick.login")}
          <Input ref={loginRef} value={user} onChange={setUser} placeholder="root" />
        </label>

        <div className="mt-3">
          <label className="text-meta text-nx-soft font-mono">
            {t("quick.password")}
          </label>
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
