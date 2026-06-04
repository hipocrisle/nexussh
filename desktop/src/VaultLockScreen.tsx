// Full-screen lock overlay. Shown on launch (before sessions reconnect) when
// a vault exists but is locked, and whenever the user locks the app. Live SSH
// sessions keep running underneath — this only gates the UI + saved secrets.
//
// Carries its own window chrome (drag region + minimize/close) because the
// app's custom titlebar isn't reachable while this overlay is up.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Minus, X, Fingerprint } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  vaultUnlock,
  vaultReset,
  biometricAvailable,
  biometricEnrolled,
  biometricUnlock,
} from "./vault";
import {
  clearHostsEncryptedFlag,
  clearKnownFolders,
  ensureHostsInVault,
} from "./hosts";

interface Props {
  onUnlocked: () => void;
}

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function VaultLockScreen({ onUnlocked }: Props) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState<string | null>(null);
  const [bioOffer, setBioOffer] = useState(false);

  // Offer fingerprint unlock only if the device supports it AND the user
  // enrolled it for this vault.
  useEffect(() => {
    let alive = true;
    (async () => {
      const ok = (await biometricEnrolled()) && (await biometricAvailable());
      if (alive) setBioOffer(ok);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function bioUnlock() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await biometricUnlock();
      await ensureHostsInVault();
      onUnlocked();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!pw || busy) return;
    setError(null);
    setBusy(true);
    try {
      await vaultUnlock(pw);
      // Make sure all host data is read from (and lives in) the vault.
      await ensureHostsInVault();
      setPw("");
      onUnlocked();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    setError(null);
    setBusy(true);
    try {
      const backup = await vaultReset();
      // The encrypted host list (if any) is gone with the vault — reads fall
      // back to the empty plaintext store, and empty folders shouldn't linger.
      clearHostsEncryptedFlag();
      clearKnownFolders();
      setResetDone(backup ?? "");
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const win = HAS_TAURI ? getCurrentWindow() : null;
  const ctrlBtn =
    "inline-flex items-center justify-center w-11 h-9 text-[var(--nx-text-muted)] hover:bg-[var(--nx-bg-panel)] hover:text-[var(--nx-text-primary)] transition-colors";

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-[var(--nx-bg-base)]">
      {/* Draggable titlebar so the window can still be moved / minimized /
          closed while locked. */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-end h-9 shrink-0 select-none"
      >
        {win && (
          <div className="flex items-stretch h-9">
            <button className={ctrlBtn} onClick={() => win.minimize()} title="Minimize">
              <Minus size={14} />
            </button>
            <button
              className="inline-flex items-center justify-center w-11 h-9 text-[var(--nx-text-muted)] hover:bg-[var(--nx-error)] hover:text-white transition-colors"
              onClick={() => win.close()}
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-sm px-6 text-center">
          <div className="flex justify-center mb-4 text-[var(--nx-accent)]">
            <Lock size={32} />
          </div>

          {resetDone !== null ? (
            <>
              <h1 className="text-lg font-mono text-[var(--nx-accent)] mb-1">
                {t("vault.reset_done_title")}
              </h1>
              <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-2">
                {t("vault.reset_done_body")}
              </p>
              {resetDone && (
                <p className="text-[11px] text-[var(--nx-text-soft)] font-mono break-all mb-5">
                  {t("vault.reset_backup")}: {resetDone}
                </p>
              )}
              <button
                type="button"
                onClick={onUnlocked}
                className="w-full py-2 bg-[var(--nx-accent)] text-[var(--nx-bg-base)] font-mono font-bold rounded"
              >
                {t("vault.reset_continue")}
              </button>
            </>
          ) : resetting ? (
            <>
              <h1 className="text-lg font-mono text-[var(--nx-error)] mb-1">
                {t("vault.reset_title")}
              </h1>
              <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-5">
                {t("vault.reset_warn")}
              </p>
              {error && (
                <div className="text-[var(--nx-error)] text-sm font-mono break-all mb-3">
                  ✗ {error}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setResetting(false)}
                  disabled={busy}
                  className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
                >
                  {t("dialog.cancel")}
                </button>
                <button
                  type="button"
                  onClick={doReset}
                  disabled={busy}
                  className="flex-1 py-2 bg-[var(--nx-error)] disabled:opacity-50 text-white font-mono font-bold rounded"
                >
                  {busy ? "..." : t("vault.reset_confirm")}
                </button>
              </div>
            </>
          ) : (
            <>
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
              {bioOffer && (
                <button
                  type="button"
                  onClick={bioUnlock}
                  disabled={busy}
                  className="w-full mt-3 py-2 border border-[var(--nx-accent)] text-[var(--nx-accent)] disabled:opacity-50 font-mono rounded flex items-center justify-center gap-2"
                >
                  <Fingerprint size={16} />
                  {t("vault.biometric_unlock")}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setResetting(true);
                }}
                className="mt-4 text-[11px] font-mono text-[var(--nx-text-muted)] hover:text-[var(--nx-text-soft)] underline"
              >
                {t("vault.forgot")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
