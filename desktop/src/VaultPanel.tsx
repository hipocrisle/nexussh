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
    "flex-1 bg-[#0e1414] border border-[#1f3a3a] rounded px-3 py-2 text-[#c9d1d9] " +
    "focus:outline-none focus:border-[#00ff95] placeholder-[#4a5560] font-mono text-sm";
  const labelBase = "text-xs uppercase tracking-wider text-[#7fd7ff] mb-1 block";
  const btnSecondary =
    "px-3 py-2 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono text-sm rounded border border-[#1f3a3a]";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl p-6"
      >
        <h2 className="text-xl font-mono text-[#00ff95] mb-1">&gt; vault</h2>
        <p className="text-xs text-[#4a5560] font-mono mb-5">
          {t("vault.subtitle")}
        </p>

        {status && (
          <div className="mb-4 text-xs font-mono">
            <span className="text-[#4a5560]">status: </span>
            {status.unlocked ? (
              <span className="text-[#00ff95]">● unlocked</span>
            ) : status.configured ? (
              <span className="text-[#f5d76e]">● locked</span>
            ) : (
              <span className="text-[#ff6b6b]">○ not configured</span>
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

          <p className="text-xs text-[#4a5560] font-mono pt-1">
            {t("vault.hint")}
          </p>

          {error && (
            <div className="text-[#ff6b6b] text-sm font-mono break-all">
              ✗ {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono rounded border border-[#1f3a3a]"
            >
              {t("dialog.cancel")}
            </button>
            {status?.unlocked && (
              <button
                type="button"
                onClick={lock}
                disabled={busy}
                className="flex-1 py-2 bg-[#f5d76e] hover:bg-[#ffe28a] disabled:opacity-50 text-[#0a0e0e] font-mono font-bold rounded"
              >
                {t("vault.lock")}
              </button>
            )}
            <button
              type="button"
              onClick={saveAndUnlock}
              disabled={busy || !vaultPath || !keyPath}
              className="flex-1 py-2 bg-[#00ff95] hover:bg-[#5fffb4] disabled:opacity-50 disabled:cursor-not-allowed text-[#0a0e0e] font-mono font-bold rounded"
            >
              {busy ? "..." : t("vault.unlock")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
