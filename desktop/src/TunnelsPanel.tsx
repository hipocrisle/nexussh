// TunnelsPanel — lists active SSH local-port forwards (ssh -L) and lets the
// user open one in the browser, stop it, or start a new ad-hoc tunnel. Opened
// from the header menu. Mirrors SFTPPanel's modal structure/styling.

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, RefreshCw, Globe, Plus, Square, Play, Trash2 } from "lucide-react";
import { TunnelInfo, PortForward, tunnelList, tunnelClose, buildOpenUrl } from "./tunnel";
import type { ConnectArgs } from "./ssh";
import { listHosts, saveHost } from "./hosts";
import { useBackdropClose } from "./useBackdropClose";
import { Button, IconButton } from "./components/primitives";
import { AddTunnelDialog } from "./AddTunnelDialog";

interface Props {
  onClose: () => void;
  /** Optional: when provided, the "+ New tunnel" button is wired to start an
   *  ad-hoc tunnel against this connection. Without it the button is hidden
   *  (no host context → nothing to connect to). */
  newTunnel?: { connectArgs: ConnectArgs; label: string } | null;
  /** Resolves the host's auth (prompting if needed), builds its ConnectArgs and
   *  opens the saved forward. Provided by App.tsx where the auth logic lives. */
  onStartSaved?: (hostId: string, fwd: PortForward) => Promise<TunnelInfo | null>;
}

/** A saved forward flattened with its owning host, for the "Saved" list. */
interface SavedForwardRow {
  hostId: string;
  hostLabel: string;
  forward: PortForward;
}

/** Heuristic: 443/8443 → https, everything else http. */
function schemeForPort(port: number): "http" | "https" {
  return port === 443 || port === 8443 ? "https" : "http";
}

export function TunnelsPanel({ onClose, newTunnel, onStartSaved }: Props) {
  const { t } = useTranslation();
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [saved, setSaved] = useState<SavedForwardRow[]>([]);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
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
      const running = tunnels.find(
        (tn) =>
          tn.label === row.hostLabel &&
          tn.local_port === row.forward.localPort &&
          tn.remote_host === row.forward.remoteHost &&
          tn.remote_port === row.forward.remotePort,
      );
      if (running) await tunnelClose(running.id);
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

  async function onOpenBrowser(tn: TunnelInfo) {
    // TunnelInfo from the backend carries no scheme/path. Best-effort: recover
    // them from a saved forward that matches this tunnel's local port (and
    // remote host:port, to disambiguate). Fall back to the port heuristic.
    const match = saved.find(
      (r) =>
        r.hostLabel === tn.label &&
        r.forward.localPort === tn.local_port &&
        r.forward.remoteHost === tn.remote_host &&
        r.forward.remotePort === tn.remote_port,
    );
    const scheme = match?.forward.scheme ?? schemeForPort(tn.remote_port);
    await open(buildOpenUrl(scheme, tn.local_port, match?.forward.path));
  }

  async function onOpenSaved(fwd: PortForward) {
    await open(
      buildOpenUrl(fwd.scheme ?? schemeForPort(fwd.remotePort), fwd.localPort, fwd.path),
    );
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

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-nx-muted font-mono text-body gap-2">
              <Loader2 size={16} className="animate-spin" /> {t("tunnel.loading")}
            </div>
          ) : tunnels.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-nx-muted font-mono text-body">
              {t("tunnel.empty")}
            </div>
          ) : (
            tunnels.map((tn) => (
              <div
                key={tn.id}
                className="flex items-center gap-3 px-4 py-2.5 border-b border-nx-divider"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-body text-nx-text truncate">
                    <span className="text-nx-accent">localhost:{tn.local_port}</span>
                    <span className="text-nx-muted mx-1.5">→</span>
                    <span className="text-nx-soft">
                      {tn.remote_host}:{tn.remote_port}
                    </span>
                  </div>
                  {tn.label && (
                    <div className="text-meta text-nx-muted font-mono truncate">
                      {tn.label}
                    </div>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Globe size={12} />}
                  onClick={() => onOpenBrowser(tn)}
                >
                  {t("tunnel.open_in_browser")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  leadingIcon={<Square size={11} />}
                  onClick={() => onStop(tn.id)}
                >
                  {t("tunnel.stop")}
                </Button>
              </div>
            ))
          )}

          {/* Saved forwards — one-click start from any host's saved tunnels. */}
          {!loading && onStartSaved && (
            <>
              <div className="px-4 pt-4 pb-1.5 text-micro uppercase tracking-[0.2em] text-nx-muted font-mono">
                {t("tunnel.saved_header")}
              </div>
              {saved.length === 0 ? (
                <div className="px-4 pb-3 text-meta text-nx-muted font-mono">
                  {t("tunnel.saved_empty")}
                </div>
              ) : (
                saved.map((row) => {
                  // Host-aware: a tunnel only counts as "this saved forward's"
                  // when its host label matches too — otherwise two hosts sharing
                  // the same local→remote ports get conflated (a forward on host A
                  // would look "running" because host B has an identical tunnel).
                  const active = tunnels.some(
                    (tn) =>
                      tn.label === row.hostLabel &&
                      tn.local_port === row.forward.localPort &&
                      tn.remote_host === row.forward.remoteHost &&
                      tn.remote_port === row.forward.remotePort,
                  );
                  return (
                    <div
                      key={`${row.hostId}:${row.forward.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 border-b border-nx-divider"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-body text-nx-text truncate">
                          <span className="text-nx-accent">
                            {row.forward.name || `localhost:${row.forward.localPort}`}
                          </span>
                          <span className="text-nx-muted mx-1.5">→</span>
                          <span className="text-nx-soft">
                            {row.forward.remoteHost}:{row.forward.remotePort}
                          </span>
                        </div>
                        <div className="text-meta text-nx-muted font-mono truncate">
                          {row.hostLabel}
                        </div>
                      </div>
                      {active ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          leadingIcon={<Globe size={12} />}
                          onClick={() => onOpenSaved(row.forward)}
                        >
                          {t("tunnel.open_in_browser")}
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          leadingIcon={
                            startingId === row.forward.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Play size={11} />
                            )
                          }
                          disabled={startingId !== null}
                          onClick={() => onStartSavedRow(row)}
                        >
                          {t("tunnel.saved_start")}
                        </Button>
                      )}
                      <IconButton
                        icon={<Trash2 size={13} />}
                        onClick={() => onDeleteSaved(row)}
                        title={t("tunnel.saved_delete")}
                      />
                    </div>
                  );
                })
              )}
            </>
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
          onClose={() => setAddOpen(false)}
          onStarted={() => {
            setAddOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
