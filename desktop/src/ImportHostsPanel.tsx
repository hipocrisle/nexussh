// ImportHostsPanel — unified host import from multiple sources:
// ~/.ssh/config, ~/.ssh/known_hosts, PuTTY (Windows Registry), Windows
// Terminal profiles. Backend aggregates and tags each entry with `source`;
// we render with a chip badge per row and cross-source dedup.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, FileText } from "lucide-react";
import {
  HostRecord,
  listHosts,
  saveHostsBatch,
  newHostId,
} from "./hosts";
import { vaultSet, hostKeyDataKey } from "./vault";
import { useSettings } from "./settings/settings-store";
import { THEMES } from "./settings/themes";
import { useBackdropClose } from "./useBackdropClose";

interface ImportableHost {
  source: string; // "ssh-config" | "known-hosts" | "putty" | "wt"
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

const IMPORT_GROUP = "imported";

const SOURCE_LABEL: Record<string, string> = {
  "ssh-config": "ssh-config",
  "known-hosts": "known_hosts",
  putty: "PuTTY",
  wt: "WT",
};

const SOURCE_COLOR: Record<string, string> = {
  "ssh-config": "var(--nx-accent)",
  "known-hosts": "var(--nx-text-soft)",
  putty: "var(--nx-warning)",
  wt: "var(--nx-accent2)",
};

interface AggregatedRow {
  // composite identity for dedup against existing hosts AND merging rows
  // that point to the same target from multiple sources
  target: string; // user@hostname:port (user may be null)
  alias: string;
  hostname: string;
  user: string | null;
  port: number;
  identity_file: string | null;
  sources: string[];
}

export function ImportHostsPanel({ onClose, onImported }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const palette = THEMES[settings.theme];
  const [raw, setRaw] = useState<ImportableHost[] | null>(null);
  const [existing, setExisting] = useState<HostRecord[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<number | null>(null);
  // Mark all imported hosts as account-synced. OFF by default.
  const [syncImported, setSyncImported] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  useEffect(() => {
    invoke<ImportableHost[]>("read_import_sources")
      .then(setRaw)
      .catch((e) => setError(String(e)));
    listHosts().then(setExisting).catch(() => {});
  }, []);

  // Merge entries that point at the same user@host:port across sources.
  // Prefer ssh-config metadata when available (it usually has the alias and
  // identity file), augment with sources from the duplicates.
  const rows = useMemo<AggregatedRow[]>(() => {
    if (!raw) return [];
    const byKey = new Map<string, AggregatedRow>();
    const sourcePrio = (s: string) =>
      s === "ssh-config" ? 0 : s === "putty" ? 1 : s === "wt" ? 2 : 3;
    for (const h of raw) {
      const port = h.port ?? 22;
      const user = h.user ?? null;
      const key = `${user ?? ""}@${h.hostname}:${port}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          target: key,
          alias: h.alias,
          hostname: h.hostname,
          user,
          port,
          identity_file: h.identity_file,
          sources: [h.source],
        });
      } else {
        existing.sources.push(h.source);
        // upgrade if this entry has higher-priority source data
        if (sourcePrio(h.source) < sourcePrio(existing.sources[0])) {
          existing.alias = h.alias;
          existing.identity_file = h.identity_file ?? existing.identity_file;
        }
      }
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.alias.localeCompare(b.alias),
    );
  }, [raw]);

  const dupKeys = useMemo(() => {
    const s = new Set<string>();
    for (const h of existing) {
      s.add(`${h.user}@${h.host}:${h.port}`);
    }
    return s;
  }, [existing]);

  const isDup = (r: AggregatedRow) =>
    dupKeys.has(`${r.user ?? settings.defaultUser}@${r.hostname}:${r.port}`);

  // Pre-select everything except duplicates whenever rows refresh.
  useEffect(() => {
    if (rows.length === 0) {
      setSelected(new Set());
      return;
    }
    const next = new Set<number>();
    rows.forEach((r, i) => {
      if (!isDup(r)) next.add(i);
    });
    setSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleAll() {
    const importable = rows.map((_, i) => i).filter((i) => !isDup(rows[i]));
    if (selected.size >= importable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(importable));
    }
  }

  async function doImport() {
    if (rows.length === 0) return;
    setBusy(true);
    setError(null);
    const pick = [...selected].filter((i) => !isDup(rows[i]));
    setProgress({ done: 0, total: pick.length });
    try {
      // Build every record first (resolving ~ in identity paths), tracking
      // progress, then persist all of them in ONE vault write — see
      // saveHostsBatch. Looping saveHost would re-encrypt the whole list N times.
      const recs: HostRecord[] = [];
      const keyData: { id: string; path: string }[] = [];
      for (const i of pick) {
        const r = rows[i];
        const idFile = r.identity_file
          ? await invoke<string>("expand_home", { path: r.identity_file })
          : null;
        const id = newHostId();
        recs.push({
          id,
          name: r.alias,
          host: r.hostname,
          port: r.port,
          user: r.user ?? settings.defaultUser,
          group: IMPORT_GROUP,
          auth: idFile ? { kind: "key" } : { kind: "password", password: "" },
          alwaysAskPassword: !idFile,
          sync: syncImported || undefined,
        });
        // key path → ЛОКАЛЬНЫЙ vault (не plaintext, не синкается)
        if (idFile) keyData.push({ id, path: idFile });
        setProgress({ done: recs.length, total: pick.length });
      }
      await saveHostsBatch(recs);
      for (const kd of keyData) {
        try {
          await vaultSet(hostKeyDataKey(kd.id), JSON.stringify({ path: kd.path }));
        } catch {
          /* vault locked — путь к ключу укажется при первом подключении */
        }
      }
      setSuccess(recs.length);
      onImported?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const importableCount = useMemo(
    () => rows.filter((r) => !isDup(r)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, dupKeys],
  );

  // Summary by source for the footer.
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      for (const s of r.sources) counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-lg border border-[var(--nx-border)] shadow-2xl overflow-hidden max-md:max-w-none max-md:max-h-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)]"
        style={{ background: palette.bgBase }}
      >
        <div
          className="h-10 px-4 flex items-center border-b"
          style={{ borderColor: palette.border, background: palette.bgSecondary }}
        >
          <FileText size={14} className="text-[var(--nx-text-soft)] mr-2" />
          <span className="font-mono text-sm text-[var(--nx-accent)]">
            {t("import.title_unified")}
          </span>
          <span className="ml-3 text-xs italic text-[var(--nx-text-muted)] font-mono">
            {t("import.subtitle")}
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
          {raw === null && !error && (
            <div className="m-4 text-[var(--nx-text-muted)]">
              {t("import.scanning")}
            </div>
          )}
          {raw && rows.length === 0 && (
            <div className="m-4 text-[var(--nx-text-muted)]">
              {t("import.empty_unified")}
            </div>
          )}
          {rows.length > 0 && (
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
                  <th className="px-2 py-2">{t("import.col_source")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dup = isDup(r);
                  const sel = selected.has(i);
                  const user = r.user ?? settings.defaultUser;
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
                        {r.alias}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--nx-text-muted)]">
                        {user}@{r.hostname}:{r.port}
                        {dup && (
                          <span className="ml-2 text-[10px] px-1.5 rounded bg-[var(--nx-bg-panel)] text-[var(--nx-warning)]">
                            {t("import.dup_badge")}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1 flex-wrap">
                          {r.sources.map((s) => (
                            <span
                              key={s}
                              className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                              style={{
                                background: "var(--nx-bg-panel)",
                                color: SOURCE_COLOR[s] ?? "var(--nx-text-soft)",
                                border: `1px solid ${SOURCE_COLOR[s] ?? "var(--nx-border)"}`,
                              }}
                            >
                              {SOURCE_LABEL[s] ?? s}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div
          className="border-t flex flex-col"
          style={{ borderColor: palette.border, background: palette.bgSecondary }}
        >
          {Object.keys(sourceCounts).length > 0 && (
            <div className="px-3 py-1.5 flex items-center gap-3 text-[10px] font-mono text-[var(--nx-text-muted)] border-b border-[var(--nx-border)]/40">
              {Object.entries(sourceCounts).map(([s, n]) => (
                <span key={s} style={{ color: SOURCE_COLOR[s] }}>
                  {SOURCE_LABEL[s] ?? s}: {n}
                </span>
              ))}
            </div>
          )}
          {progress && (
            <div className="px-3 pt-2">
              <div className="flex items-center justify-between text-[10px] font-mono text-[var(--nx-text-muted)] mb-1">
                <span>{t("import.saving")}</span>
                <span>
                  {progress.done} / {progress.total}
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden bg-[var(--nx-bg-panel)]">
                <div
                  className="h-full bg-[var(--nx-accent)] transition-all duration-150"
                  style={{
                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
          <div className="h-12 px-3 flex items-center gap-2">
            <span className="text-xs font-mono text-[var(--nx-text-muted)]">
              {t("import.selected", {
                n: selected.size,
                total: importableCount,
              })}
            </span>
            <label className="flex items-center gap-1.5 cursor-pointer text-xs font-mono text-[var(--nx-text-soft)]">
              <input
                type="checkbox"
                checked={syncImported}
                onChange={(e) => setSyncImported(e.target.checked)}
                className="accent-[var(--nx-accent)]"
              />
              {t("import.sync_imported")}
            </label>
            <button
              onClick={onClose}
              className="ml-auto px-3 py-1.5 font-mono text-xs rounded border border-[var(--nx-border)] text-[var(--nx-text-soft)] hover:bg-[var(--nx-bg-panel)]"
            >
              {t("dialog.cancel")}
            </button>
            <button
              onClick={doImport}
              disabled={busy || selected.size === 0 || rows.length === 0}
              className="px-4 py-1.5 font-mono text-xs rounded bg-[var(--nx-accent)] text-[var(--nx-bg-base)] font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy
                ? t("import.importing")
                : t("import.do_import", { n: selected.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
