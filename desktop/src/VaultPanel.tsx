// VaultPanel — configure paths + unlock/lock. Shown as a modal.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  VaultStatus,
  vaultStatus,
  vaultSetPaths,
  vaultUnlock,
  vaultLock,
} from "./vault";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  onClose: () => void;
  onChange?: (status: VaultStatus) => void;
}

export function VaultPanel({ onClose, onChange }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [vaultPath, setVaultPath] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  const refresh = async () => {
    const s = await vaultStatus();
    setStatus(s);
    setVaultPath(s.vault_path ?? "");
    setKeyPath(s.key_path ?? "");
    onChange?.(s);
  };

  useEffect(() => {
    refresh();
  }, []);

  async function pick(setter: (v: string) => void, label: string) {
    const file = await open({
      multiple: false,
      title: label,
    });
    if (typeof file === "string") setter(file);
  }

  async function saveAndUnlock() {
    setError(null);
    setBusy(true);
    try {
      await vaultSetPaths(vaultPath, keyPath);
      await vaultUnlock();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    try {
      await vaultLock();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const inputBase =
    "flex-1 bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-3 py-2 text-[var(--nx-text-primary)] " +
    "focus:outline-none focus:border-[var(--nx-accent)] placeholder-[var(--nx-text-muted)] font-mono text-sm";
  const labelBase = "text-xs uppercase tracking-wider text-[var(--nx-text-soft)] mb-1 block";
  const btnSecondary =
    "px-3 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono text-sm rounded border border-[var(--nx-border)]";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-lg bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:overflow-y-auto max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-1">&gt; vault</h2>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-5">
          {t("vault.subtitle")}
        </p>

        {status && (
          <div className="mb-4 text-xs font-mono">
            <span className="text-[var(--nx-text-muted)]">status: </span>
            {status.unlocked ? (
              <span className="text-[var(--nx-accent)]">● unlocked</span>
            ) : status.configured ? (
              <span className="text-[var(--nx-warning)]">● locked</span>
            ) : (
              <span className="text-[var(--nx-error)]">○ not configured</span>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className={labelBase}>{t("vault.vault_file")}</label>
            <div className="flex gap-2">
              <input
                value={vaultPath}
                onChange={(e) => setVaultPath(e.target.value)}
                placeholder="/path/to/vault.age"
                className={inputBase}
              />
              <button
                type="button"
                onClick={() => pick(setVaultPath, t("vault.vault_file"))}
                className={btnSecondary}
              >
                {t("vault.browse")}
              </button>
            </div>
          </div>
          <div>
            <label className={labelBase}>{t("vault.key_file")}</label>
            <div className="flex gap-2">
              <input
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="/path/to/vault.key"
                className={inputBase}
              />
              <button
                type="button"
                onClick={() => pick(setKeyPath, t("vault.key_file"))}
                className={btnSecondary}
              >
                {t("vault.browse")}
              </button>
            </div>
          </div>

          <p className="text-xs text-[var(--nx-text-muted)] font-mono pt-1">
            {t("vault.hint")}
          </p>

          {error && (
            <div className="text-[var(--nx-error)] text-sm font-mono break-all">
              ✗ {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
            >
              {t("dialog.cancel")}
            </button>
            {status?.unlocked && (
              <button
                type="button"
                onClick={lock}
                disabled={busy}
                className="flex-1 py-2 bg-[var(--nx-warning)] hover:bg-[var(--nx-warning)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
              >
                {t("vault.lock")}
              </button>
            )}
            <button
              type="button"
              onClick={saveAndUnlock}
              disabled={busy || !vaultPath || !keyPath}
              className="flex-1 py-2 bg-[var(--nx-accent)] hover:bg-[var(--nx-accent)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--nx-bg-base)] font-mono font-bold rounded"
            >
              {busy ? "..." : t("vault.unlock")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
