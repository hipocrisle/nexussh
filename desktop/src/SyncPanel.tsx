// SyncPanel — quick cloud-sync status + actions. Modal, same chrome as VaultPanel.
// Heavy account management (login, 2FA, password, delete) lives in Settings →
// Account; this panel is the fast path: see status + "Sync now" in one click.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, CloudOff, RefreshCw, Loader2, Check, Settings as SettingsIcon } from "lucide-react";
import { accountStatus, accountSyncNow, AccountStatus, SyncReport } from "./account";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  onClose: () => void;
  onOpenSettings: () => void;
}

export function SyncPanel({ onClose, onOpenSettings }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  async function refresh() {
    try {
      setStatus(await accountStatus());
    } catch {
      setStatus(null);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      setReport(await accountSyncNow());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status?.logged_in;
  const lastSync = status?.last_sync_at
    ? new Date(status.last_sync_at).toLocaleString()
    : t("sync.never");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-md bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:overflow-y-auto max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-1 flex items-center gap-2">
          {connected ? <Cloud size={18} /> : <CloudOff size={18} />} &gt; sync
        </h2>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-5">
          {t("sync.subtitle")}
        </p>

        {/* Status box */}
        <div
          className="rounded border p-4 font-mono text-xs space-y-2 mb-4"
          style={{ background: "var(--nx-bg-panel)", borderColor: "var(--nx-border)" }}
        >
          <div className="flex justify-between gap-4">
            <span className="text-[var(--nx-text-muted)]">{t("sync.state")}</span>
            <span style={{ color: connected ? "var(--nx-accent)" : "var(--nx-text-muted)" }}>
              {status
                ? connected
                  ? t("sync.connected")
                  : status.configured
                    ? t("sync.signed_out")
                    : t("sync.no_account")
                : "…"}
            </span>
          </div>
          {status?.username && (
            <div className="flex justify-between gap-4">
              <span className="text-[var(--nx-text-muted)]">{t("sync.account")}</span>
              <span className="text-[var(--nx-text-primary)]">{status.username}</span>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <span className="text-[var(--nx-text-muted)]">{t("sync.last_sync")}</span>
            <span className="text-[var(--nx-text-primary)]">{lastSync}</span>
          </div>
        </div>

        {/* Sync-now result */}
        {report && (
          <div
            className="rounded border p-3 font-mono text-[11px] mb-4 flex items-center gap-2"
            style={{ background: "var(--nx-bg-panel)", borderColor: "var(--nx-border)", color: "var(--nx-accent)" }}
          >
            <Check size={12} />
            {t("sync.result", {
              pulled: report.pulled,
              pushed: report.pushed,
              conflicts: report.conflicts,
            })}
          </div>
        )}
        {error && (
          <div className="text-[11px] font-mono mb-4" style={{ color: "var(--nx-error)" }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {connected && (
            <button
              type="button"
              onClick={syncNow}
              disabled={busy}
              className="font-mono text-sm px-4 py-2 rounded inline-flex items-center gap-2 disabled:opacity-50"
              style={{ background: "var(--nx-accent)", color: "var(--nx-bg-base)" }}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {busy ? t("sync.syncing") : t("sync.sync_now")}
            </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            className="font-mono text-sm px-4 py-2 rounded inline-flex items-center gap-2 border"
            style={{ borderColor: "var(--nx-border)", color: "var(--nx-text-primary)" }}
          >
            <SettingsIcon size={14} /> {t("sync.open_settings")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-sm px-4 py-2 rounded ml-auto"
            style={{ color: "var(--nx-text-muted)" }}
          >
            {t("sync.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
