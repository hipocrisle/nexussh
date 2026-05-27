// UpdatePanel — modal that shows current/new version and lets user install.
//
// Two entry points:
//   1. Manual: "Check for updates" button in Settings opens this with a "check now" pre-fired.
//   2. Auto: maybeAutoCheck() on app startup; if update found, this opens automatically.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Download, X } from "lucide-react";
import {
  UpdateInfo,
  checkForUpdate,
  installUpdate,
  markChecked,
} from "./updater";

interface Props {
  /** Pre-populated update info (e.g. from auto-check on startup). */
  initial?: UpdateInfo | null;
  onClose: () => void;
}

export function UpdatePanel({ initial, onClose }: Props) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<UpdateInfo | null | "checking" | undefined>(
    initial === undefined ? undefined : initial,
  );
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runCheck() {
    setError(null);
    setInfo("checking");
    try {
      const r = await checkForUpdate();
      setInfo(r);
      markChecked();
    } catch (e) {
      setError(String(e));
      setInfo(null);
    }
  }

  useEffect(() => {
    if (initial === undefined) runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runInstall() {
    setError(null);
    setInstalling(true);
    try {
      await installUpdate();
      // install_update restarts the app; if we're still here, that didn't happen
    } catch (e) {
      setError(String(e));
      setInstalling(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl"
      >
        <div className="flex items-center px-4 py-3 border-b border-[#1f3a3a]">
          <h2 className="text-lg font-mono text-[#00ff95]">
            &gt; {t("update.title")}
          </h2>
          <button
            onClick={onClose}
            disabled={installing}
            className="ml-auto p-1.5 rounded hover:bg-[#1f3a3a] text-[#7fd7ff] disabled:opacity-30"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm font-mono">
          {info === "checking" && (
            <div className="flex items-center gap-2 text-[#7fd7ff]">
              <Loader2 size={14} className="animate-spin" />
              {t("update.checking")}
            </div>
          )}
          {info === null && !error && (
            <div className="text-[#c9d1d9]">✓ {t("update.up_to_date")}</div>
          )}
          {info && info !== "checking" && (
            <>
              <div className="text-[#00ff95] text-base">
                {t("update.new_available")}
              </div>
              <div className="text-[#c9d1d9]">
                <span className="text-[#4a5560]">{t("update.current")}: </span>
                <span>{info.current_version}</span>
              </div>
              <div className="text-[#c9d1d9]">
                <span className="text-[#4a5560]">{t("update.new")}: </span>
                <span className="text-[#00ff95]">{info.version}</span>
              </div>
              {info.date && (
                <div className="text-[#4a5560] text-xs">
                  {t("update.released_on", { date: info.date })}
                </div>
              )}
              {info.body && (
                <div className="mt-3 bg-[#0e1414] border border-[#1f3a3a] rounded p-3 text-xs text-[#c9d1d9] whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {info.body}
                </div>
              )}
            </>
          )}
          {error && (
            <div className="text-[#ff6b6b] text-xs break-all">✗ {error}</div>
          )}
        </div>

        <div className="flex gap-2 px-4 py-3 border-t border-[#1f3a3a]">
          <button
            onClick={runCheck}
            disabled={info === "checking" || installing}
            className="flex-1 py-2 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono rounded border border-[#1f3a3a] disabled:opacity-50"
          >
            {t("update.check_again")}
          </button>
          {info && info !== "checking" && (
            <button
              onClick={runInstall}
              disabled={installing}
              className="flex-1 py-2 bg-[#00ff95] hover:bg-[#5fffb4] text-[#0a0e0e] font-mono font-bold rounded disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {installing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t("update.installing")}
                </>
              ) : (
                <>
                  <Download size={14} />
                  {t("update.install_restart")}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
