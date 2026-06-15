// TunnelsPanel — ONE unified list of SSH local-port forwards (ssh -L). Each
// forward shows up exactly once: saved forwards are merged with the live
// `tunnelList`, so a saved forward that is currently running renders a single
// row (not one "active" + one "saved" duplicate). Active tunnels with no saved
// definition appear as ad-hoc rows. Opened from the header menu; mirrors
// SFTPPanel's modal structure/styling.

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Loader2,
  RefreshCw,
  Globe,
  Plus,
  Square,
  Play,
  Trash2,
  Pencil,
} from "lucide-react";
import {
  TunnelInfo,
  PortForward,
  tunnelList,
  tunnelClose,
  buildOpenUrl,
} from "./tunnel";
import type { ConnectArgs } from "./ssh";
import { listHosts, saveHost } from "./hosts";
import { useBackdropClose } from "./useBackdropClose";
import { Button, IconButton } from "./components/primitives";
import { AddTunnelDialog } from "./AddTunnelDialog";
import { ForwardEditDialog } from "./ForwardEditDialog";
import type { HostRecord } from "./hosts";

interface Props {
  onClose: () => void;
  /** Optional: when provided, the "+ New tunnel" button is wired to start an
   *  ad-hoc tunnel against this connection. Without it the button is hidden
   *  (no host context → nothing to connect to). `host` (when set) lets the add
   *  dialog persist the started forward to that host's config. */
  newTunnel?: {
    connectArgs: ConnectArgs;
    label: string;
    host?: HostRecord;
  } | null;
  /** Resolves the host's auth (prompting if needed), builds its ConnectArgs and
   *  opens the saved forward. Provided by App.tsx where the auth logic lives. */
  onStartSaved?: (hostId: string, fwd: PortForward) => Promise<TunnelInfo | null>;
}

/** A saved forward flattened with its owning host. */
interface SavedForwardRow {
  hostId: string;
  hostLabel: string;
  forward: PortForward;
}

/** One row in the unified list. Either a saved forward (with optional live
 *  tunnel attached) or an ad-hoc active tunnel that has no saved definition. */
interface MergedRow {
  /** Stable React key. */
  key: string;
  /** Set for saved forwards; absent for ad-hoc active tunnels. */
  saved?: SavedForwardRow;
  /** Set when this forward is currently running. */
  live?: TunnelInfo;
  /** Display fields, resolved from whichever source we have. */
  primary: string;
  remoteHost: string;
  remotePort: number;
  subline: string;
}

/** Heuristic: 443/8443 → https, everything else http. */
function schemeForPort(port: number): "http" | "https" {
  return port === 443 || port === 8443 ? "https" : "http";
}

/** Host-aware match: a live tunnel belongs to a saved forward only when the
 *  host label matches too, so two hosts sharing identical ports aren't
 *  conflated. */
function tunnelMatchesForward(tn: TunnelInfo, row: SavedForwardRow): boolean {
  return (
    tn.label === row.hostLabel &&
    tn.local_port === row.forward.localPort &&
    tn.remote_host === row.forward.remoteHost &&
    tn.remote_port === row.forward.remotePort
  );
}

export function TunnelsPanel({ onClose, newTunnel, onStartSaved }: Props) {
  const { t } = useTranslation();
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [saved, setSaved] = useState<SavedForwardRow[]>([]);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SavedForwardRow | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await tunnelList();
      if (aliveRef.current) {
        setTunnels(list);
        setError(null);
      }
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  // Saved forwards rarely change while the panel is open, so load them once
  // (not on the 4s active-tunnel poll).
  const loadSaved = useCallback(async () => {
    try {
      const hosts = await listHosts();
      const rows: SavedForwardRow[] = [];
      for (const h of hosts) {
        for (const f of h.forwards ?? []) {
          rows.push({
            hostId: h.id,
            hostLabel: h.name || `${h.user}@${h.host}`,
            forward: f,
          });
        }
      }
      if (aliveRef.current) setSaved(rows);
    } catch {
      /* host list unreadable (vault locked) — show no saved rows */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    loadSaved();
    const iv = window.setInterval(refresh, 4000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(iv);
    };
  }, [refresh, loadSaved]);

  // --- Build the unified, de-duplicated list ---------------------------------
  // 1. Each saved forward becomes one row; attach the live tunnel if running,
  //    and remember its id so we don't list it again as ad-hoc.
  // 2. Any remaining (unmatched) live tunnel is an ad-hoc row.
  // When opened from a host's right-click (newTunnel.host set), scope the list
  // to THAT host — otherwise right-clicking host A would show host B's forwards.
  // Opened from the header button (no host) → show everything.
  const scopeHostId = newTunnel?.host?.id ?? null;
  const scopeLabel = newTunnel?.host
    ? newTunnel.host.name || `${newTunnel.host.user}@${newTunnel.host.host}`
    : null;

  const matchedLiveIds = new Set<string>();
  const rows: MergedRow[] = [];
  for (const row of saved) {
    if (scopeHostId && row.hostId !== scopeHostId) continue;
    const live = tunnels.find((tn) => tunnelMatchesForward(tn, row));
    if (live) matchedLiveIds.add(live.id);
    rows.push({
      key: `saved:${row.hostId}:${row.forward.id}`,
      saved: row,
      live,
      primary: row.forward.name || `localhost:${row.forward.localPort}`,
      remoteHost: row.forward.remoteHost,
      remotePort: row.forward.remotePort,
      subline: row.hostLabel,
    });
  }
  for (const tn of tunnels) {
    if (matchedLiveIds.has(tn.id)) continue;
    if (scopeLabel && tn.label !== scopeLabel) continue;
    rows.push({
      key: `live:${tn.id}`,
      live: tn,
      primary: `localhost:${tn.local_port}`,
      remoteHost: tn.remote_host,
      remotePort: tn.remote_port,
      subline: tn.label,
    });
  }

  async function onStartSavedRow(row: SavedForwardRow) {
    if (!onStartSaved) return;
    setError(null);
    setStartingId(row.forward.id);
    try {
      await onStartSaved(row.hostId, row.forward);
      await refresh();
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setStartingId(null);
    }
  }

  // Delete a saved forward from its host (and stop it if it's currently running).
  async function onDeleteSaved(row: SavedForwardRow) {
    setError(null);
    try {
      const hosts = await listHosts();
      const h = hosts.find((x) => x.id === row.hostId);
      if (h) {
        await saveHost({
          ...h,
          forwards: (h.forwards ?? []).filter((f) => f.id !== row.forward.id),
        });
      }
      const running = tunnels.find((tn) => tunnelMatchesForward(tn, row));
      if (running) await tunnelClose(running.id);
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    }
    await loadSaved();
    await refresh();
  }

  // Persist an edited forward back onto its host, preserving its id.
  async function onSaveEdit(updated: PortForward) {
    if (!editing) return;
    const row = editing;
    setEditing(null);
    setError(null);
    try {
      const hosts = await listHosts();
      const h = hosts.find((x) => x.id === row.hostId);
      if (h) {
        await saveHost({
          ...h,
          forwards: (h.forwards ?? []).map((f) =>
            f.id === row.forward.id ? updated : f,
          ),
        });
      }
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    }
    await loadSaved();
    await refresh();
  }

  async function onStop(id: string) {
    setError(null);
    try {
      await tunnelClose(id);
    } catch (e) {
      setError(String(e));
    }
    refresh();
  }

  async function open(url: string) {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  }

  // Open a row in the browser. Saved rows use their stored scheme/path; ad-hoc
  // rows fall back to the port heuristic with no path.
  async function onOpenRow(r: MergedRow) {
    const localPort = r.live ? r.live.local_port : r.saved!.forward.localPort;
    const scheme =
      r.saved?.forward.scheme ?? schemeForPort(r.remotePort);
    await open(buildOpenUrl(scheme, localPort, r.saved?.forward.path));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="nx-modal-enter w-full max-w-2xl max-h-[80vh] flex flex-col bg-nx-bg border border-nx-border rounded-nx shadow-glow-md overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-divider shrink-0">
          <h2 className="text-lg font-mono text-nx-accent">&gt; tunnels</h2>
          <span className="text-meta text-nx-muted font-mono">
            {tunnels.length} {t("tunnel.active_count")}
          </span>
          <IconButton
            icon={<RefreshCw size={13} />}
            onClick={refresh}
            title={t("sftp.refresh")}
            className="ml-1"
          />
          {newTunnel && (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Plus size={12} />}
              onClick={() => setAddOpen(true)}
              className="ml-auto"
            >
              {t("tunnel.new")}
            </Button>
          )}
          <IconButton
            className={newTunnel ? "" : "ml-auto"}
            icon={<span className="text-base leading-none">×</span>}
            onClick={onClose}
            title={t("tabmenu.close")}
          />
        </div>

        {/* Body — single unified list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-nx-muted font-mono text-body gap-2">
              <Loader2 size={16} className="animate-spin" /> {t("tunnel.loading")}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-nx-muted font-mono text-body">
              {t("tunnel.none")}
            </div>
          ) : (
            rows.map((r) => {
              const running = !!r.live;
              const isSaved = !!r.saved;
              return (
                <div
                  key={r.key}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-nx-divider"
                >
                  {/* Status dot */}
                  <span
                    className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                      running ? "bg-nx-accent" : "bg-nx-muted/50"
                    }`}
                    title={running ? t("tunnel.saved_running") : t("tunnel.stop")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-body text-nx-text truncate">
                      <span className="text-nx-accent">{r.primary}</span>
                      <span className="text-nx-muted mx-1.5">→</span>
                      <span className="text-nx-soft">
                        {r.remoteHost}:{r.remotePort}
                      </span>
                    </div>
                    {r.subline && (
                      <div className="text-meta text-nx-muted font-mono truncate">
                        {r.subline}
                      </div>
                    )}
                  </div>

                  {/* Primary action: open (running) or start (saved+stopped) */}
                  {running ? (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        leadingIcon={<Globe size={12} />}
                        onClick={() => onOpenRow(r)}
                      >
                        {t("tunnel.open_in_browser")}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        leadingIcon={<Square size={11} />}
                        onClick={() => onStop(r.live!.id)}
                      >
                        {t("tunnel.stop")}
                      </Button>
                    </>
                  ) : (
                    isSaved && (
                      <Button
                        variant="secondary"
                        size="sm"
                        leadingIcon={
                          startingId === r.saved!.forward.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Play size={11} />
                          )
                        }
                        disabled={startingId !== null}
                        onClick={() => onStartSavedRow(r.saved!)}
                      >
                        {t("tunnel.saved_start")}
                      </Button>
                    )
                  )}

                  {/* Saved rows also get edit + delete */}
                  {isSaved && (
                    <>
                      <IconButton
                        icon={<Pencil size={13} />}
                        onClick={() => setEditing(r.saved!)}
                        title={t("tunnel.edit")}
                      />
                      <IconButton
                        icon={<Trash2 size={13} />}
                        onClick={() => onDeleteSaved(r.saved!)}
                        title={t("tunnel.saved_delete")}
                      />
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer status */}
        <div className="px-4 py-2 border-t border-nx-divider font-mono text-meta shrink-0">
          {error ? (
            <span className="text-nx-error truncate">✗ {error}</span>
          ) : (
            <span className="text-nx-muted">
              {tunnels.length} {t("tunnel.active_count")}
            </span>
          )}
        </div>
      </div>

      {addOpen && newTunnel && (
        <AddTunnelDialog
          connectArgs={newTunnel.connectArgs}
          label={newTunnel.label}
          host={newTunnel.host}
          onClose={() => setAddOpen(false)}
          onStarted={() => {
            setAddOpen(false);
            loadSaved();
            refresh();
          }}
        />
      )}

      {editing && (
        <ForwardEditDialog
          initial={editing.forward}
          onClose={() => setEditing(null)}
          onSave={onSaveEdit}
        />
      )}
    </div>
  );
}
