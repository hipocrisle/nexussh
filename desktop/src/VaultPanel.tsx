// VaultPanel — create / unlock / lock the passphrase-protected vault. Modal.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  VaultStatus,
  vaultStatus,
  vaultCreate,
  vaultUnlock,
  vaultChangePassword,
  vaultListBackups,
  vaultRestoreBackup,
  VaultBackup,
} from "./vault";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  onClose: () => void;
  onChange?: (status: VaultStatus) => void;
  /** Lock the whole app (master-password screen); keeps SSH sessions alive. */
  onLock?: () => void;
}

export function VaultPanel({ onClose, onChange, onLock }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Change-password sub-flow (manage mode).
  const [changing, setChanging] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [changedOk, setChangedOk] = useState(false);
  // Restore-from-backup sub-flow (shown in create mode when backups exist).
  const [backups, setBackups] = useState<VaultBackup[]>([]);
  const [restoreMode, setRestoreMode] = useState(false);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  async function restore(path: string) {
    setError(null);
    setBusy(true);
    try {
      await vaultRestoreBackup(path);
      setRestoreMode(false);
      await refresh(); // now configured + locked → switches to unlock mode
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword() {
    setError(null);
    if (newPw.length < 6) return setError(t("vault.err_short"));
    if (newPw !== newPw2) return setError(t("vault.err_mismatch"));
    setBusy(true);
    try {
      await vaultChangePassword(oldPw, newPw);
      setOldPw("");
      setNewPw("");
      setNewPw2("");
      setChanging(false);
      setChangedOk(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const refresh = async () => {
    const s = await vaultStatus();
    setStatus(s);
    onChange?.(s);
  };

  useEffect(() => {
    refresh();
    vaultListBackups().then(setBackups).catch(() => {});
  }, []);

  // Three modes: create (not configured), unlock (configured+locked), manage (unlocked).
  const mode: "create" | "unlock" | "manage" = !status
    ? "unlock"
    : !status.configured
      ? "create"
      : status.unlocked
        ? "manage"
        : "unlock";

  async function submit() {
    setError(null);
    if (mode === "create") {
      if (pw.length < 6) return setError(t("vault.err_short"));
      if (pw !== pw2) return setError(t("vault.err_mismatch"));
    }
    setBusy(true);
    try {
      if (mode === "create") await vaultCreate(pw);
      else await vaultUnlock(pw);
      setPw("");
      setPw2("");
      await refresh();
      // Success → just close and get back to work; no extra clicks.
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputBase =
    "w-full bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-3 py-2 text-[var(--nx-text-primary)] " +
    "focus:outline-none focus:border-[var(--nx-accent)] placeholder-[var(--nx-text-muted)] font-mono text-sm";
  const labelBase =
    "text-xs uppercase tracking-wider text-[var(--nx-text-soft)] mb-1 block";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-md bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:overflow-y-auto max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-1">&gt; vault</h2>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-5">
          {mode === "create"
            ? t("vault.create_subtitle")
            : mode === "unlock"
              ? t("vault.unlock_subtitle")
              : t("vault.manage_subtitle")}
        </p>

        {status && (
          <div className="mb-4 text-xs font-mono">
            <span className="text-[var(--nx-text-muted)]">status: </span>
            {status.unlocked ? (
              <span className="text-[var(--nx-accent)]">● unlocked</span>
            ) : status.configured ? (
              <span className="text-[var(--nx-warning)]">● locked</span>
            ) : (
              <span className="text-[var(--nx-error)]">○ not created</span>
            )}
          </div>
        )}

        {restoreMode && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-2">
              {t("vault.restore_subtitle")}
            </p>
            {backups.length === 0 && (
              <p className="text-sm text-[var(--nx-text-muted)] font-mono">
                {t("vault.restore_none")}
              </p>
            )}
            {backups.map((b) => (
              <button
                key={b.path}
                type="button"
                disabled={busy}
                onClick={() => restore(b.path)}
                className="w-full text-left px-3 py-2 rounded border border-[var(--nx-border)] bg-[var(--nx-bg-panel)] hover:border-[var(--nx-accent)] font-mono text-xs disabled:opacity-50"
              >
                <span className="text-[var(--nx-text-primary)]">
                  {b.created
                    ? new Date(b.created * 1000).toLocaleString()
                    : b.path.split(/[\\/]/).pop()}
                </span>
                <span className="block text-[10px] text-[var(--nx-text-muted)] break-all">
                  {b.path.split(/[\\/]/).pop()}
                </span>
              </button>
            ))}
          </div>
        )}

        {mode !== "manage" && !restoreMode && (
          <div className="space-y-3">
            <div>
              <label className={labelBase}>
                {mode === "create"
                  ? t("vault.new_master")
                  : t("vault.master")}
              </label>
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && mode === "unlock" && submit()}
                placeholder="••••••••"
                autoFocus
                className={inputBase}
              />
            </div>
            {mode === "create" && (
              <div>
                <label className={labelBase}>{t("vault.confirm_master")}</label>
                <input
                  type="password"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="••••••••"
                  className={inputBase}
                />
              </div>
            )}
            <p className="text-xs text-[var(--nx-text-muted)] font-mono pt-1">
              {mode === "create" ? t("vault.create_hint") : t("vault.unlock_hint")}
            </p>
            {mode === "create" && backups.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setRestoreMode(true);
                }}
                className="text-xs font-mono text-[var(--nx-accent)] hover:underline"
              >
                {t("vault.restore_btn")} ({backups.length}) →
              </button>
            )}
          </div>
        )}

        {mode === "manage" && !changing && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--nx-text-primary)] font-mono">
              {t("vault.manage_body")}
            </p>
            {changedOk && (
              <p className="text-xs text-[var(--nx-accent)] font-mono">
                ✓ {t("vault.change_done")}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setChangedOk(false);
                setChanging(true);
              }}
              className="text-xs font-mono text-[var(--nx-accent)] hover:underline"
            >
              {t("vault.change_btn")} →
            </button>
          </div>
        )}

        {mode === "manage" && changing && (
          <div className="space-y-3">
            <div>
              <label className={labelBase}>{t("vault.old_master")}</label>
              <input
                type="password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                placeholder="••••••••"
                autoFocus
                className={inputBase}
              />
            </div>
            <div>
              <label className={labelBase}>{t("vault.new_master")}</label>
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="••••••••"
                className={inputBase}
              />
            </div>
            <div>
              <label className={labelBase}>{t("vault.confirm_master")}</label>
              <input
                type="password"
                value={newPw2}
                onChange={(e) => setNewPw2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && changePassword()}
                placeholder="••••••••"
                className={inputBase}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="text-[var(--nx-error)] text-sm font-mono break-all mt-3">
            ✗ {error}
          </div>
        )}

        <div className="flex gap-2 pt-5">
          {restoreMode ? (
            <button
              type="button"
              onClick={() => {
                setRestoreMode(false);
                setError(null);
              }}
              className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
            >
              {t("vault.back")}
            </button>
          ) : mode === "manage" && changing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setChanging(false);
                  setError(null);
                }}
                className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
              >
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                onClick={changePassword}
                disabled={busy || !oldPw || !newPw}
                className="flex-1 py-2 bg-[var(--nx-accent)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
              >
                {busy ? "..." : t("vault.change_save")}
              </button>
            </>
          ) : mode === "manage" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 bg-[var(--nx-accent)] text-[var(--nx-bg-base)] font-mono font-bold rounded"
              >
                {t("vault.done")}
              </button>
              <button
                type="button"
                onClick={() => onLock?.()}
                className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
              >
                {t("vault.lock")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
              >
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !pw}
                className="flex-1 py-2 bg-[var(--nx-accent)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--nx-bg-base)] font-mono font-bold rounded"
              >
                {busy ? "..." : mode === "create" ? t("vault.create_btn") : t("vault.unlock")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
