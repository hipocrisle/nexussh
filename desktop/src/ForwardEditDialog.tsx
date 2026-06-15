// ForwardEditDialog — add/edit a single saved port-forward (PortForward) on a
// host's config. Pure config editing: it does NOT start a tunnel (that's
// AddTunnelDialog's job). Vertically-stacked labeled fields mirror the visual
// style of AddTunnelDialog. On save, returns the resolved PortForward to the
// caller (HostDialog), which keeps it in local state until the host is saved.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { PortForward } from "./tunnel";
import { useBackdropClose } from "./useBackdropClose";
import { Button, Input, RowLabel, Checkbox } from "./components/primitives";
import { Select } from "./Select";

interface Props {
  /** Existing forward when editing; undefined when adding a new one. */
  initial?: PortForward;
  onClose: () => void;
  /** Returns the resolved forward (new id when adding, same id when editing). */
  onSave: (f: PortForward) => void;
}

export function ForwardEditDialog({ initial, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [localPort, setLocalPort] = useState(
    initial && initial.localPort ? String(initial.localPort) : "",
  );
  const [remoteHost, setRemoteHost] = useState(initial?.remoteHost ?? "127.0.0.1");
  const [remotePort, setRemotePort] = useState(
    initial && initial.remotePort ? String(initial.remotePort) : "",
  );
  const [scheme, setScheme] = useState<"http" | "https">(initial?.scheme ?? "https");
  const [path, setPath] = useState(initial?.path ?? "");
  const [autoStart, setAutoStart] = useState(!!initial?.autoStart);
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  const isEdit = !!initial;
  const rport = parseInt(remotePort, 10);
  const canSave = remotePort.trim() !== "" && rport > 0;

  function doSave() {
    setError(null);
    if (!(rport > 0)) {
      setError(t("tunnel.err_port_required"));
      return;
    }
    // Mirror HostDialog's doSave cleanup: empty local port → 0 (OS-picked),
    // empty optional fields → undefined.
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim() || undefined,
      localPort: parseInt(localPort, 10) || 0,
      remoteHost: remoteHost.trim() || "127.0.0.1",
      remotePort: rport,
      scheme,
      path: path.trim() || undefined,
      autoStart: autoStart || undefined,
    });
  }

  const kicker = "text-micro uppercase tracking-[0.2em] text-nx-accent";

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) doSave();
        }}
        {...contentProps}
        className="nx-modal-enter relative w-[440px] max-w-[94vw] bg-nx-panel rounded-nx-lg p-7 shadow-elev-modal max-md:w-full max-md:max-w-none max-md:h-full max-md:max-h-none max-md:rounded-none max-md:p-4 max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <span className="nx-brackets">
          <i />
        </span>

        {/* Title */}
        <div className="flex items-baseline gap-3 pb-4 border-b border-nx-divider mb-5">
          <span className={kicker}>
            // {isEdit ? t("dialog.forward_edit_title") : t("dialog.forward_new_title")}
          </span>
          <div className="text-h2 text-nx-text font-mono">
            <span className="text-nx-accent mr-2">&gt;</span>
            forward
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1.5 text-nx-muted hover:text-nx-text"
          >
            <X size={14} />
          </button>
        </div>

        <div>
          <RowLabel>{t("dialog.forward_name_optional")}</RowLabel>
          <Input
            value={name}
            onChange={setName}
            placeholder={t("dialog.forward_name_ph")}
            autoFocus
          />
        </div>

        <div className="grid grid-cols-[1fr_1fr] gap-3 mt-4">
          <div>
            <RowLabel>{t("dialog.forward_local_port")}</RowLabel>
            <Input
              value={localPort}
              onChange={setLocalPort}
              inputMode="numeric"
              placeholder={t("dialog.forward_local_port_ph")}
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

        <div className="grid grid-cols-[1fr_132px] gap-3 mt-4">
          <div className="min-w-0">
            <RowLabel>{t("tunnel.remote_host")}</RowLabel>
            <Input
              value={remoteHost}
              onChange={setRemoteHost}
              placeholder={t("dialog.forward_rhost_ph")}
            />
          </div>
          <div className="min-w-0">
            <RowLabel className="whitespace-nowrap">{t("tunnel.remote_port")}</RowLabel>
            <Input
              value={remotePort}
              onChange={setRemotePort}
              inputMode="numeric"
              placeholder={t("dialog.forward_rport_ph")}
              invalid={!!error}
            />
          </div>
        </div>

        <div className="mt-4">
          <RowLabel>{t("tunnel.path")}</RowLabel>
          <Input value={path} onChange={setPath} placeholder={t("dialog.forward_path_ph")} />
        </div>

        <div className="mt-5">
          <Checkbox
            checked={autoStart}
            onChange={setAutoStart}
            label={t("dialog.forward_autostart_label")}
          />
        </div>

        {error && (
          <div className="text-nx-error text-body font-mono mt-5 break-words">✗ {error}</div>
        )}

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-nx-divider flex items-center gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSave}>
            {t("dialog.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
