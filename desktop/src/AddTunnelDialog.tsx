// AddTunnelDialog — start an ad-hoc SSH local-port forward (ssh -L) against an
// already-resolved ConnectArgs. Local port 0 = OS-picked. Errors (busy port,
// auth) surface inline; on success the caller is handed the live TunnelInfo.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Loader2 } from "lucide-react";
import type { ConnectArgs } from "./ssh";
import { TunnelInfo, tunnelOpen } from "./tunnel";
import { useBackdropClose } from "./useBackdropClose";
import { Button, Input, RowLabel } from "./components/primitives";
import { Select } from "./Select";

interface Props {
  connectArgs: ConnectArgs;
  label: string;
  onClose: () => void;
  onStarted: (info: TunnelInfo) => void;
}

export function AddTunnelDialog({ connectArgs, label, onClose, onStarted }: Props) {
  const { t } = useTranslation();
  const [localPort, setLocalPort] = useState("0");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("");
  const [scheme, setScheme] = useState<"http" | "https">("https");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  const rport = parseInt(remotePort, 10);
  const canStart = !busy && remotePort.trim() !== "" && rport > 0;

  async function start() {
    setError(null);
    if (!(rport > 0)) {
      setError(t("tunnel.err_port_required"));
      return;
    }
    setBusy(true);
    try {
      const info = await tunnelOpen(connectArgs, {
        localPort: parseInt(localPort, 10) || 0,
        remoteHost: remoteHost.trim() || "127.0.0.1",
        remotePort: rport,
        label,
      });
      onStarted(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const kicker = "text-micro uppercase tracking-[0.2em] text-nx-accent";

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canStart) start();
        }}
        {...contentProps}
        className="nx-modal-enter relative w-[440px] max-w-[94vw] bg-nx-panel rounded-nx-lg p-7 shadow-elev-modal"
      >
        <span className="nx-brackets">
          <i />
        </span>

        {/* Title */}
        <div className="flex items-baseline gap-3 pb-4 border-b border-nx-divider mb-5">
          <span className={kicker}>// {t("tunnel.dialog_title")}</span>
          <div className="text-h2 text-nx-text font-mono">
            <span className="text-nx-accent mr-2">&gt;</span>
            tunnel
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1.5 text-nx-muted hover:text-nx-text"
          >
            <X size={14} />
          </button>
        </div>

        <div className="text-meta text-nx-muted font-mono truncate mb-4">{label}</div>

        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <div>
            <RowLabel>{t("tunnel.local_port")}</RowLabel>
            <Input
              value={localPort}
              onChange={setLocalPort}
              inputMode="numeric"
              placeholder={t("tunnel.local_port_ph")}
              autoFocus
            />
          </div>
          <div>
            <RowLabel>{t("tunnel.scheme")}</RowLabel>
            <Select
              className="mt-1.5"
              value={scheme}
              onChange={(v) => setScheme(v as "http" | "https")}
              options={[
                { value: "https", label: "https" },
                { value: "http", label: "http" },
              ]}
            />
          </div>
        </div>

        <div className="grid grid-cols-[1fr_90px] gap-3 mt-4">
          <div>
            <RowLabel>{t("tunnel.remote_host")}</RowLabel>
            <Input
              value={remoteHost}
              onChange={setRemoteHost}
              placeholder={t("dialog.forward_rhost_ph")}
            />
          </div>
          <div>
            <RowLabel>{t("tunnel.remote_port")}</RowLabel>
            <Input
              value={remotePort}
              onChange={setRemotePort}
              inputMode="numeric"
              placeholder={t("dialog.forward_rport_ph")}
            />
          </div>
        </div>

        {error && (
          <div className="text-nx-error text-body font-mono mt-5 break-words">
            ✗ {error}
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-nx-divider flex items-center gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!canStart}>
            {busy ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> {t("tunnel.starting")}
              </span>
            ) : (
              t("tunnel.start")
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
