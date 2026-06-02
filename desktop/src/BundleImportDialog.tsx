// Import a shared NexuSSH bundle: pick the encrypted file, enter the shared
// passphrase, and merge its hosts (and optional VPN profiles) into the local
// store. Hosts always land as "ask password every time".

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BundlePayload,
  readBundle,
  importBundleHosts,
  importBundleVpn,
} from "./bundle";
import { useSettings } from "./settings/settings-store";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  onClose: () => void;
}

export function BundleImportDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const [path, setPath] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [payload, setPayload] = useState<BundlePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  async function pickFile() {
    setError(null);
    setPayload(null);
    try {
      const p = await open({
        multiple: false,
        title: t("bundle.pick_file"),
        filters: [{ name: "NexuSSH bundle", extensions: ["nxbundle"] }],
      });
      if (typeof p === "string") setPath(p);
    } catch (e) {
      setError(String(e));
    }
  }

  async function decrypt() {
    setError(null);
    if (!path) {
      setError(t("bundle.err_no_file"));
      return;
    }
    if (!pass.trim()) {
      setError(t("bundle.err_pass"));
      return;
    }
    setBusy(true);
    try {
      const pl = await readBundle(path, pass);
      setPayload(pl);
    } catch {
      setError(t("bundle.err_decrypt"));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      const { added, skipped } = await importBundleHosts(
        payload,
        settings.defaultUser,
      );
      const vpnAdded = importBundleVpn(payload);
      setDone(t("bundle.imported", { added, skipped, vpn: vpnAdded }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputBase =
    "w-full bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-3 py-2 text-[var(--nx-text-primary)] focus:outline-none focus:border-[var(--nx-accent)] placeholder-[var(--nx-text-muted)] font-mono text-sm";
  const label = "text-xs uppercase tracking-wider text-[var(--nx-text-soft)] mb-1 block";

  const fileName = path ? path.split(/[\\/]/).pop() : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-md bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-1">
          &gt; {t("bundle.import_title")}
        </h2>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-4">
          {t("bundle.import_subtitle")}
        </p>

        {done ? (
          <div className="space-y-4">
            <p className="text-sm font-mono text-[var(--nx-text-primary)]">
              ✓ {done}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2 bg-[var(--nx-accent)] text-[var(--nx-bg-base)] font-mono font-bold rounded"
            >
              {t("bundle.close")}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={label}>{t("bundle.file")}</label>
              <button
                type="button"
                onClick={pickFile}
                className="w-full py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono text-sm rounded border border-[var(--nx-border)] truncate px-3"
              >
                {fileName || t("bundle.pick_file")}
              </button>
            </div>

            <div>
              <label className={label}>{t("bundle.passphrase")}</label>
              <input
                type="text"
                value={pass}
                onChange={(e) => {
                  setPass(e.target.value);
                  setPayload(null);
                }}
                placeholder={t("bundle.passphrase_ph")}
                className={inputBase}
              />
            </div>

            {payload && (
              <div className="text-xs font-mono text-[var(--nx-accent)] border border-[var(--nx-border)] rounded px-3 py-2">
                {t("bundle.preview", {
                  hosts: payload.hosts.length,
                  vpn: payload.vpn?.length ?? 0,
                })}
              </div>
            )}

            {error && (
              <div className="text-[var(--nx-error)] text-sm font-mono break-all">
                ✗ {error}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
              >
                {t("dialog.cancel")}
              </button>
              {payload ? (
                <button
                  type="button"
                  onClick={doImport}
                  disabled={busy}
                  className="flex-1 py-2 bg-[var(--nx-accent)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
                >
                  {busy ? "..." : t("bundle.import_btn")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={decrypt}
                  disabled={busy || !path}
                  className="flex-1 py-2 bg-[var(--nx-accent)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
                >
                  {busy ? "..." : t("bundle.decrypt_btn")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
