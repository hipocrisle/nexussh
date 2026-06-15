// TunnelsPanel — lists active SSH local-port forwards (ssh -L) and lets the
// user open one in the browser, stop it, or start a new ad-hoc tunnel. Opened
// from the header menu. Mirrors SFTPPanel's modal structure/styling.

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, RefreshCw, Globe, Plus, Square } from "lucide-react";
import { TunnelInfo, tunnelList, tunnelClose } from "./tunnel";
import type { ConnectArgs } from "./ssh";
import { useBackdropClose } from "./useBackdropClose";
import { Button, IconButton } from "./components/primitives";
import { AddTunnelDialog } from "./AddTunnelDialog";

interface Props {
  onClose: () => void;
  /** Optional: when provided, the "+ New tunnel" button is wired to start an
   *  ad-hoc tunnel against this connection. Without it the button is hidden
   *  (no host context → nothing to connect to). */
  newTunnel?: { connectArgs: ConnectArgs; label: string } | null;
}

/** Heuristic: 443/8443 → https, everything else http. */
function schemeForPort(port: number): "http" | "https" {
  return port === 443 || port === 8443 ? "https" : "http";
}

export function TunnelsPanel({ onClose, newTunnel }: Props) {
  const { t } = useTranslation();
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
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

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const iv = window.setInterval(refresh, 4000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(iv);
    };
  }, [refresh]);

  async function onStop(id: string) {
    setError(null);
    try {
      await tunnelClose(id);
    } catch (e) {
      setError(String(e));
    }
    refresh();
  }

  async function onOpenBrowser(tn: TunnelInfo) {
    const scheme = schemeForPort(tn.remote_port);
    const url = `${scheme}://localhost:${tn.local_port}`;
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
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
            <div className="flex items-center justify-center h-32 text-nx-muted font-mono text-body">
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
