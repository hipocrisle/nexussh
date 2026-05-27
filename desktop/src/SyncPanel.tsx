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
        className="w-full max-w-lg bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl p-6 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-xl font-mono text-[#00ff95] mb-1">&gt; sync</h2>
        <p className="text-xs text-[#4a5560] font-mono mb-5">
          {t("sync.subtitle")}
        </p>

        {status && (
          <div className="mb-4 text-xs font-mono space-y-0.5">
            <div>
              <span className="text-[#4a5560]">status: </span>
              {status.unlocked ? (
                <span className="text-[#00ff95]">● unlocked</span>
              ) : status.configured ? (
                <span className="text-[#f5d76e]">● locked</span>
              ) : (
                <span className="text-[#ff6b6b]">○ not configured</span>
              )}
            </div>
            {status.file_path && status.file_exists && (
              <div className="text-[#4a5560]">
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
            <p className="text-xs text-[#4a5560] font-mono mt-1">
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
            <p className="text-xs text-[#4a5560] font-mono mt-1">
              {t("sync.pwd_hint")}
            </p>
          </div>

          {info && (
            <div className="text-[#00ff95] text-sm font-mono">✓ {info}</div>
          )}
          {error && (
            <div className="text-[#ff6b6b] text-sm font-mono break-all">
              ✗ {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="py-2 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono rounded border border-[#1f3a3a]"
            >
              {t("dialog.cancel")}
            </button>
            <button
              type="button"
              onClick={saveAndUnlock}
              disabled={busy || !filePath || !password}
              className="py-2 bg-[#00ff95] hover:bg-[#5fffb4] disabled:opacity-50 disabled:cursor-not-allowed text-[#0a0e0e] font-mono font-bold rounded"
            >
              {busy ? "..." : t("sync.unlock_btn")}
            </button>
            {status?.unlocked && (
              <>
                <button
                  type="button"
                  onClick={pushNow}
                  disabled={busy}
                  className="py-2 bg-[#5cc8ff] hover:bg-[#7fd7ff] disabled:opacity-50 text-[#0a0e0e] font-mono font-bold rounded"
                >
                  ↑ {t("sync.push")}
                </button>
                <button
                  type="button"
                  onClick={pullNow}
                  disabled={busy}
                  className="py-2 bg-[#5cc8ff] hover:bg-[#7fd7ff] disabled:opacity-50 text-[#0a0e0e] font-mono font-bold rounded"
                >
                  ↓ {t("sync.pull")}
                </button>
                <button
                  type="button"
                  onClick={lockNow}
                  disabled={busy}
                  className="col-span-2 py-2 bg-[#f5d76e] hover:bg-[#ffe28a] disabled:opacity-50 text-[#0a0e0e] font-mono font-bold rounded"
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
