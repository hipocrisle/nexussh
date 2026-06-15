// HostInfoCard — modal "preview" of a host: shown when the user taps/clicks a
// host in the sidebar. Has Connect + Edit buttons + an X close.
// Mobile: fullscreen sheet. Desktop: centered card.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Server,
  Folder,
  User,
  Lock,
  KeyRound,
  Database,
  Clock,
  X,
} from "lucide-react";
import { HostRecord } from "./hosts";

interface Props {
  host: HostRecord;
  onConnect: () => void;
  onEdit: () => void;
  onClose: () => void;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function authBadge(auth: HostRecord["auth"]) {
  if (auth.kind === "password") {
    return { icon: <Lock size={12} />, label: "password" };
  }
  if (auth.kind === "key") {
    return { icon: <KeyRound size={12} />, label: `key (${auth.path})` };
  }
  // The host's own password lives under an auto-generated `host.<id>.password`
  // key — showing that raw uuid just overflows the card. Use a friendly label;
  // only custom vault keys are worth showing verbatim.
  return {
    icon: <Database size={12} />,
    label: /^host\.h-[\w-]+\.password$/.test(auth.key)
      ? "vault (пароль хоста)"
      : `vault: ${auth.key}`,
  };
}

export function HostInfoCard({ host, onConnect, onEdit, onClose }: Props) {
  const { t } = useTranslation();
  const auth = authBadge(host.auth);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm max-md:bg-nx-bg max-md:backdrop-blur-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="nx-modal-enter w-full max-w-md bg-nx-panel border border-nx-border rounded-lg p-6 font-mono shadow-2xl max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:flex max-md:flex-col max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <div className="flex items-center gap-3 mb-4">
          <Server size={20} className="text-nx-accent" />
          <h2 className="text-xl text-nx-accent flex-1 truncate">
            {host.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("dialog.close")}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full text-nx-muted hover:text-nx-text hover:bg-nx-elevated active:bg-nx-bg-2"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 text-sm max-md:flex-1 max-md:overflow-y-auto">
          <div className="flex gap-2 text-nx-text">
            <span className="text-nx-muted w-20">host:</span>
            <span className="break-all">
              {host.user}@{host.host}:{host.port}
            </span>
          </div>
          <div className="flex gap-2 text-nx-text">
            <span className="text-nx-muted w-20 flex items-center gap-1">
              <User size={10} /> user:
            </span>
            <span>{host.user}</span>
          </div>
          {host.group && (
            <div className="flex gap-2 text-nx-text">
              <span className="text-nx-muted w-20 flex items-center gap-1">
                <Folder size={10} /> folder:
              </span>
              <span className="break-all">{host.group}</span>
            </div>
          )}
          <div className="flex gap-2 text-nx-text">
            <span className="text-nx-muted w-20">auth:</span>
            <span className="flex items-center gap-1 text-nx-soft">
              {auth.icon}
              <span className="break-all">{auth.label}</span>
            </span>
          </div>
          <div className="flex gap-2 text-nx-text">
            <span className="text-nx-muted w-20 flex items-center gap-1">
              <Clock size={10} /> last:
            </span>
            <span>{fmtDate(host.lastUsedAt)}</span>
          </div>
          {host.note && (
            <div className="mt-3 pt-3 border-t border-nx-border">
              <div className="text-[10px] uppercase tracking-wider text-nx-soft mb-1">
                {t("info.note")}
              </div>
              <div className="text-nx-text text-xs whitespace-pre-wrap">
                {host.note}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mt-5">
          <button
            onClick={onEdit}
            className="py-2 max-md:py-3 bg-nx-panel hover:bg-nx-elevated text-nx-soft rounded border border-nx-border"
          >
            {t("info.edit")}
          </button>
          <button
            onClick={onConnect}
            className="py-2 max-md:py-3 bg-nx-accent text-nx-bg font-bold rounded"
          >
            {t("info.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
