// SyncPanel — encrypted host-list sync configuration + manual push/pull.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import {
  SyncStatus,
  syncStatus,
  syncSetConfig,
  syncUnlock,
  syncLock,
  syncPush,
  syncPull,
} from "./sync";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  onClose: () => void;
  onChange?: (status: SyncStatus) => void;
}

const BACKENDS = [
  { id: "syncthing", labelKey: "sync.backend_syncthing" },
  { id: "nextcloud", labelKey: "sync.backend_nextcloud" },
  { id: "gdrive", labelKey: "sync.backend_gdrive" },
  { id: "dropbox", labelKey: "sync.backend_dropbox" },
  { id: "onedrive", labelKey: "sync.backend_onedrive" },
  { id: "local", labelKey: "sync.backend_local" },
] as const;

export function SyncPanel({ onClose, onChange }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [filePath, setFilePath] = useState("");
  const [backend, setBackend] = useState<string>("syncthing");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  const refresh = async () => {
    const s = await syncStatus();
    setStatus(s);
    setFilePath(s.file_path ?? "");
    setBackend(s.backend_label ?? "syncthing");
    onChange?.(s);
  };

  useEffect(() => {
    refresh();
  }, []);

  async function pickPath() {
    const p = await save({
      title: t("sync.choose_file"),
      defaultPath: "nexussh-hosts.age",
      filters: [
        { name: "NexuSSH sync blob", extensions: ["age", "nexussh", "json"] },
      ],
    });
    if (typeof p === "string") setFilePath(p);
  }

  async function saveAndUnlock() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      await syncSetConfig(filePath, backend);
      await syncUnlock(password);
      setPassword("");
      await refresh();
      setInfo(t("sync.unlocked"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pushNow() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      await syncPush();
      await refresh();
      setInfo(t("sync.push_done"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pullNow() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const n = await syncPull();
      await refresh();
      setInfo(t("sync.pull_done", { count: n }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function lockNow() {
    setBusy(true);
    try {
      await syncLock();
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
        className="w-full max-w-lg bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-h-[90vh] overflow-y-auto max-md:max-w-none max-md:max-h-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-1">&gt; sync</h2>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-5">
          {t("sync.subtitle")}
        </p>

        {status && (
          <div className="mb-4 text-xs font-mono space-y-0.5">
            <div>
              <span className="text-[var(--nx-text-muted)]">status: </span>
              {status.unlocked ? (
                <span className="text-[var(--nx-accent)]">● unlocked</span>
              ) : status.configured ? (
                <span className="text-[var(--nx-warning)]">● locked</span>
              ) : (
                <span className="text-[var(--nx-error)]">○ not configured</span>
              )}
            </div>
            {status.file_path && status.file_exists && (
              <div className="text-[var(--nx-text-muted)]">
                file: {status.file_path} (mtime {status.file_mtime})
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className={labelBase}>{t("sync.backend")}</label>
            <select
              value={backend}
              onChange={(e) => setBackend(e.target.value)}
              className={inputBase}
            >
              {BACKENDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {t(b.labelKey)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelBase}>{t("sync.file_path")}</label>
            <div className="flex gap-2">
              <input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="C:\Syncthing\nexussh\hosts.age"
                className={inputBase}
              />
              <button
                type="button"
                onClick={pickPath}
                className={btnSecondary}
              >
                {t("vault.browse")}
              </button>
            </div>
            <p className="text-xs text-[var(--nx-text-muted)] font-mono mt-1">
              {t("sync.path_hint")}
            </p>
          </div>
          <div>
            <label className={labelBase}>{t("sync.master_password")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="•••••••••••"
              className={inputBase}
            />
            <p className="text-xs text-[var(--nx-text-muted)] font-mono mt-1">
              {t("sync.pwd_hint")}
            </p>
          </div>

          {info && (
            <div className="text-[var(--nx-accent)] text-sm font-mono">✓ {info}</div>
          )}
          {error && (
            <div className="text-[var(--nx-error)] text-sm font-mono break-all">
              ✗ {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
            >
              {t("dialog.cancel")}
            </button>
            <button
              type="button"
              onClick={saveAndUnlock}
              disabled={busy || !filePath || !password}
              className="py-2 bg-[var(--nx-accent)] hover:bg-[var(--nx-accent)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--nx-bg-base)] font-mono font-bold rounded"
            >
              {busy ? "..." : t("sync.unlock_btn")}
            </button>
            {status?.unlocked && (
              <>
                <button
                  type="button"
                  onClick={pushNow}
                  disabled={busy}
                  className="py-2 bg-[var(--nx-accent2)] hover:bg-[var(--nx-text-soft)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
                >
                  ↑ {t("sync.push")}
                </button>
                <button
                  type="button"
                  onClick={pullNow}
                  disabled={busy}
                  className="py-2 bg-[var(--nx-accent2)] hover:bg-[var(--nx-text-soft)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
                >
                  ↓ {t("sync.pull")}
                </button>
                <button
                  type="button"
                  onClick={lockNow}
                  disabled={busy}
                  className="col-span-2 py-2 bg-[var(--nx-warning)] hover:bg-[var(--nx-warning)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
                >
                  {t("sync.lock_btn")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
