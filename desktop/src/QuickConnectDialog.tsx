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
  const pwRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Username is usually the default — focus the password straight away.
    pwRef.current?.querySelector("input")?.focus();
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
          <Input value={user} onChange={setUser} placeholder="root" />
        </label>

        <div ref={pwRef} className="mt-3">
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
