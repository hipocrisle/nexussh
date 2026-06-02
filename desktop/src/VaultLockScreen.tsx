// Full-screen lock overlay. Shown on launch (before sessions reconnect) when
// a vault exists but is locked, and whenever the user locks the app. Live SSH
// sessions keep running underneath — this only gates the UI + saved secrets.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { vaultUnlock } from "./vault";

interface Props {
  onUnlocked: () => void;
}

export function VaultLockScreen({ onUnlocked }: Props) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!pw || busy) return;
    setError(null);
    setBusy(true);
    try {
      await vaultUnlock(pw);
      setPw("");
      onUnlocked();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--nx-bg-base)]">
      <div className="w-full max-w-sm px-6 text-center">
        <div className="flex justify-center mb-4 text-[var(--nx-accent)]">
          <Lock size={32} />
        </div>
        <h1 className="text-lg font-mono text-[var(--nx-accent)] mb-1">
          {t("vault.locked_title")}
        </h1>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-5">
          {t("vault.locked_subtitle")}
        </p>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("vault.master")}
          autoFocus
          className="w-full bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-3 py-2 text-center text-[var(--nx-text-primary)] focus:outline-none focus:border-[var(--nx-accent)] font-mono text-sm"
        />
        {error && (
          <div className="text-[var(--nx-error)] text-sm font-mono break-all mt-3">
            ✗ {error}
          </div>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !pw}
          className="w-full mt-4 py-2 bg-[var(--nx-accent)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
        >
          {busy ? "..." : t("vault.unlock")}
        </button>
      </div>
    </div>
  );
}
