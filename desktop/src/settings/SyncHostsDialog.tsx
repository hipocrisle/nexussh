// SyncHostsDialog — central "choose what to sync" manager. Lists every host
// grouped by folder, each with a checkbox bound to its `sync` flag. The user
// picks what rides the account sync here instead of editing each host dialog.
// Modeled on BundleExportDialog's tree-checklist UX. Saving writes the updated
// flags back in one batched write via saveHostsBatch.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CloudUpload } from "lucide-react";
import { listHosts, saveHostsBatch, HostRecord } from "../hosts";
import { accountRecordTombstones, accountSyncNow } from "../account";
import { useBackdropClose } from "../useBackdropClose";

interface Props {
  onClose: () => void;
  /** Called after a successful save so the parent can refresh counts/state. */
  onSaved?: () => void;
}

const UNGROUPED = " ungrouped";

export function SyncHostsDialog({ onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  useEffect(() => {
    listHosts()
      .then((h) => {
        setHosts(h);
        setSel(new Set(h.filter((x) => x.sync).map((x) => x.id)));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, HostRecord[]>();
    for (const h of hosts) {
      const g = h.group || UNGROUPED;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(h);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [hosts]);

  function toggleHost(id: string) {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFolder(ids: string[], allOn: boolean) {
    setSel((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  const allIds = hosts.map((h) => h.id);
  const allOn = allIds.length > 0 && allIds.every((id) => sel.has(id));

  function selectAll(on: boolean) {
    setSel(on ? new Set(allIds) : new Set());
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Only write hosts whose flag actually changed. Collect un-flagged hosts
      // (sync true→false) so we record explicit deletion tombstones — the ONLY
      // way a deletion propagates (the engine never infers deletions).
      const changed: HostRecord[] = [];
      const unsynced: string[] = [];
      for (const h of hosts) {
        const want = sel.has(h.id);
        const have = !!h.sync;
        if (want !== have) changed.push({ ...h, sync: want });
        if (have && !want) unsynced.push(h.id);
      }
      if (changed.length > 0) await saveHostsBatch(changed);
      if (unsynced.length > 0) await accountRecordTombstones(unsynced);
      // Push/pull immediately so the change reaches other devices now. Best
      // effort: a sync failure (e.g. offline) shouldn't lose the saved flags.
      try {
        await accountSyncNow();
      } catch {
        /* surfaced elsewhere; flags are already saved locally */
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const folderName = (g: string) => (g === UNGROUPED ? t("bundle.ungrouped") : g);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-lg bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-h-[90vh] overflow-y-auto max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-1">
          &gt; {t("settings.account.manage_sync_title")}
        </h2>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-4">
          {t("settings.account.manage_sync_subtitle")}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 font-mono text-xs text-[var(--nx-text-muted)] py-6">
            <Loader2 size={14} className="animate-spin" />{" "}
            {t("settings.account.loading")}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-[var(--nx-accent)]">
                {t("settings.account.sync_count", {
                  selected: sel.size,
                  total: hosts.length,
                })}
              </span>
              {hosts.length > 0 && (
                <button
                  type="button"
                  onClick={() => selectAll(!allOn)}
                  className="font-mono text-[11px] uppercase tracking-wider text-[var(--nx-text-soft)] hover:text-[var(--nx-accent)]"
                >
                  {allOn
                    ? t("settings.account.select_none")
                    : t("settings.account.select_all")}
                </button>
              )}
            </div>

            <div className="border border-[var(--nx-border)] rounded max-h-72 overflow-y-auto p-2 space-y-2">
              {groups.length === 0 && (
                <div className="text-xs font-mono text-[var(--nx-text-muted)] px-1 py-4 text-center">
                  {t("settings.account.no_hosts_at_all")}
                </div>
              )}
              {groups.map(([g, list]) => {
                // Tree cascade: a folder governs its WHOLE subtree (itself + all
                // nested subfolders), so ticking a parent folder marks every host
                // beneath it for sync, not just its direct children.
                const ids = hosts
                  .filter((h) => {
                    const hg = h.group || UNGROUPED;
                    return hg === g || hg.startsWith(g + "/");
                  })
                  .map((h) => h.id);
                const groupOn = ids.length > 0 && ids.every((id) => sel.has(id));
                return (
                  <div key={g}>
                    <label className="flex items-center gap-2 cursor-pointer py-0.5">
                      <input
                        type="checkbox"
                        checked={groupOn}
                        onChange={() => toggleFolder(ids, groupOn)}
                        className="accent-[var(--nx-accent)]"
                      />
                      <span className="font-mono text-xs text-[var(--nx-text-soft)] uppercase tracking-wider">
                        {folderName(g)} ({list.length})
                      </span>
                    </label>
                    <div className="pl-6 space-y-0.5 mt-0.5">
                      {list.map((h) => (
                        <label
                          key={h.id}
                          className="flex items-center gap-2 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={sel.has(h.id)}
                            onChange={() => toggleHost(h.id)}
                            className="accent-[var(--nx-accent)]"
                          />
                          <span className="font-mono text-xs text-[var(--nx-text-primary)] truncate">
                            {h.name || h.host}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--nx-text-muted)] truncate">
                            {h.user ? `${h.user}@` : ""}
                            {h.host}:{h.port}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

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
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="flex-1 py-2 bg-[var(--nx-accent)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded inline-flex items-center justify-center gap-2"
              >
                {busy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <CloudUpload size={14} />
                )}
                {t("settings.account.save_sync")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
