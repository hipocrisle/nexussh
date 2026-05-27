// SshConfigImportPanel — preview modal listing entries parsed from the
// user's ~/.ssh/config and letting them pick which to import as NexuSSH
// host records. Duplicates (same user@host:port) are pre-detected and
// shown disabled with an "already exists" badge.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, FileText } from "lucide-react";
import {
  HostRecord,
  listHosts,
  saveHost,
  newHostId,
} from "./hosts";
import { useSettings } from "./settings/settings-store";
import { THEMES } from "./settings/themes";

interface SshConfigHost {
  alias: string;
  hostname: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
}

interface Props {
  onClose: () => void;
  onImported?: () => void;
}

const IMPORT_GROUP = "ssh-config";

export function SshConfigImportPanel({ onClose, onImported }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const palette = THEMES[settings.theme];
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null);
  const [existing, setExisting] = useState<HostRecord[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<number | null>(null);

  useEffect(() => {
    invoke<SshConfigHost[]>("read_ssh_config")
      .then(setHosts)
      .catch((e) => setError(String(e)));
    listHosts().then(setExisting).catch(() => {});
  }, []);

  // Pre-select everything except already-imported duplicates.
  const dupKeys = useMemo(() => {
    const s = new Set<string>();
    for (const h of existing) {
      s.add(`${h.user}@${h.host}:${h.port}`);
    }
    return s;
  }, [existing]);

  const isDup = (h: SshConfigHost) =>
    dupKeys.has(`${h.user ?? settings.defaultUser}@${h.hostname}:${h.port ?? 22}`);

  useEffect(() => {
    if (!hosts) return;
    const next = new Set<number>();
    hosts.forEach((h, i) => {
      if (!isDup(h)) next.add(i);
    });
    setSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts]);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleAll() {
    if (!hosts) return;
    const importable = hosts.map((_, i) => i).filter((i) => !isDup(hosts[i]));
    if (selected.size >= importable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(importable));
    }
  }

  async function doImport() {
    if (!hosts) return;
    setBusy(true);
    setError(null);
    try {
      let count = 0;
      for (const i of selected) {
        const h = hosts[i];
        if (isDup(h)) continue;
        const idFile = h.identity_file
          ? await invoke<string>("expand_home", { path: h.identity_file })
          : null;
        const rec: HostRecord = {
          id: newHostId(),
          name: h.alias,
          host: h.hostname,
          port: h.port ?? 22,
          user: h.user ?? settings.defaultUser,
          group: IMPORT_GROUP,
          auth: idFile
            ? { kind: "key", path: idFile }
            : { kind: "password", password: "" },
          alwaysAskPassword: !idFile,
        };
        await saveHost(rec);
        count += 1;
      }
      setSuccess(count);
      onImported?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const importableCount = useMemo(
    () => (hosts ?? []).filter((h) => !isDup(h)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hosts, dupKeys],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-[var(--nx-border)] shadow-2xl overflow-hidden"
        style={{ background: palette.bgBase }}
      >
        <div
          className="h-10 px-4 flex items-center border-b"
          style={{ borderColor: palette.border, background: palette.bgSecondary }}
        >
          <FileText size={14} className="text-[var(--nx-text-soft)] mr-2" />
          <span className="font-mono text-sm text-[var(--nx-accent)]">
            {t("import.title")}
          </span>
          <span className="ml-3 text-xs italic text-[var(--nx-text-muted)] font-mono">
            ~/.ssh/config
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto font-mono text-xs">
          {error && (
            <div className="m-4 p-3 border border-[var(--nx-error)] rounded text-[var(--nx-error)]">
              ✗ {error}
            </div>
          )}
          {success !== null && (
            <div className="m-4 p-3 border border-[var(--nx-accent)] rounded text-[var(--nx-accent)]">
              ✓ {t("import.success", { n: success })}
            </div>
          )}
          {hosts === null && !error && (
            <div className="m-4 text-[var(--nx-text-muted)]">
              {t("import.loading")}
            </div>
          )}
          {hosts && hosts.length === 0 && (
            <div className="m-4 text-[var(--nx-text-muted)]">
              {t("import.empty")}
            </div>
          )}
          {hosts && hosts.length > 0 && (
            <table className="w-full">
              <thead className="sticky top-0 bg-[var(--nx-bg-secondary)]">
                <tr className="text-left uppercase tracking-wider text-[10px] text-[var(--nx-text-soft)]">
                  <th className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={
                        selected.size > 0 &&
                        selected.size >= importableCount
                      }
                      onChange={toggleAll}
                      className="accent-[var(--nx-accent)]"
                    />
                  </th>
                  <th className="px-2 py-2">{t("import.col_alias")}</th>
                  <th className="px-2 py-2">{t("import.col_target")}</th>
                  <th className="px-2 py-2">{t("import.col_auth")}</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((h, i) => {
                  const dup = isDup(h);
                  const sel = selected.has(i);
                  const user = h.user ?? settings.defaultUser;
                  const port = h.port ?? 22;
                  return (
                    <tr
                      key={i}
                      onClick={() => !dup && toggle(i)}
                      className={
                        "border-t border-[var(--nx-border)] " +
                        (dup
                          ? "opacity-50 cursor-not-allowed"
                          : "cursor-pointer hover:bg-[var(--nx-bg-panel)]")
                      }
                    >
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={sel && !dup}
                          disabled={dup}
                          onChange={() => toggle(i)}
                          onClick={(e) => e.stopPropagation()}
                          className="accent-[var(--nx-accent)]"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-[var(--nx-text-primary)]">
                        {h.alias}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--nx-text-muted)]">
                        {user}@{h.hostname}:{port}
                        {dup && (
                          <span className="ml-2 text-[10px] px-1.5 rounded bg-[var(--nx-bg-panel)] text-[var(--nx-warning)]">
                            {t("import.dup_badge")}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--nx-text-soft)] truncate max-w-[180px]">
                        {h.identity_file ?? t("import.password_ask")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div
          className="h-12 px-3 border-t flex items-center gap-2"
          style={{ borderColor: palette.border, background: palette.bgSecondary }}
        >
          <span className="text-xs font-mono text-[var(--nx-text-muted)]">
            {t("import.selected", { n: selected.size, total: importableCount })}
          </span>
          <button
            onClick={onClose}
            className="ml-auto px-3 py-1.5 font-mono text-xs rounded border border-[var(--nx-border)] text-[var(--nx-text-soft)] hover:bg-[var(--nx-bg-panel)]"
          >
            {t("dialog.cancel")}
          </button>
          <button
            onClick={doImport}
            disabled={busy || selected.size === 0 || !hosts}
            className="px-4 py-1.5 font-mono text-xs rounded bg-[var(--nx-accent)] text-[var(--nx-bg-base)] font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? t("import.importing") : t("import.do_import", { n: selected.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
