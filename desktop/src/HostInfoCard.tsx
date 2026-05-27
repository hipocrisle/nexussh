// HostInfoCard — read-only summary shown in the main area when a host is
// selected in sidebar but not yet connected. Single-click selects, double-click
// connects; this is the "preview" between those two intents.

import { useTranslation } from "react-i18next";
import { Server, Folder, User, Lock, KeyRound, Database, Clock } from "lucide-react";
import { HostRecord } from "./hosts";

interface Props {
  host: HostRecord;
  onConnect: () => void;
  onEdit: () => void;
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
  return { icon: <Database size={12} />, label: `vault: ${auth.key}` };
}

export function HostInfoCard({ host, onConnect, onEdit }: Props) {
  const { t } = useTranslation();
  const auth = authBadge(host.auth);
  return (
    <div className="h-full w-full flex items-center justify-center p-8 bg-[#0a0e0e]">
      <div className="max-w-md w-full bg-[#0e1414] border border-[#1f3a3a] rounded-lg p-6 font-mono">
        <div className="flex items-center gap-3 mb-4">
          <Server size={20} className="text-[#00ff95]" />
          <h2 className="text-xl text-[#00ff95]">{host.name}</h2>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex gap-2 text-[#c9d1d9]">
            <span className="text-[#4a5560] w-20">host:</span>
            <span>
              {host.user}@{host.host}:{host.port}
            </span>
          </div>
          <div className="flex gap-2 text-[#c9d1d9]">
            <span className="text-[#4a5560] w-20 flex items-center gap-1">
              <User size={10} /> user:
            </span>
            <span>{host.user}</span>
          </div>
          {host.group && (
            <div className="flex gap-2 text-[#c9d1d9]">
              <span className="text-[#4a5560] w-20 flex items-center gap-1">
                <Folder size={10} /> folder:
              </span>
              <span>{host.group}</span>
            </div>
          )}
          <div className="flex gap-2 text-[#c9d1d9]">
            <span className="text-[#4a5560] w-20">auth:</span>
            <span className="flex items-center gap-1 text-[#7fd7ff]">
              {auth.icon}
              <span className="break-all">{auth.label}</span>
            </span>
          </div>
          <div className="flex gap-2 text-[#c9d1d9]">
            <span className="text-[#4a5560] w-20 flex items-center gap-1">
              <Clock size={10} /> last:
            </span>
            <span>{fmtDate(host.lastUsedAt)}</span>
          </div>
          {host.note && (
            <div className="mt-3 pt-3 border-t border-[#1f3a3a]">
              <div className="text-[10px] uppercase tracking-wider text-[#7fd7ff] mb-1">
                {t("info.note")}
              </div>
              <div className="text-[#c9d1d9] text-xs whitespace-pre-wrap">
                {host.note}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mt-5">
          <button
            onClick={onEdit}
            className="py-2 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] rounded border border-[#1f3a3a]"
          >
            {t("info.edit")}
          </button>
          <button
            onClick={onConnect}
            className="py-2 bg-[#00ff95] hover:bg-[#5fffb4] text-[#0a0e0e] font-bold rounded"
          >
            {t("info.connect")}
          </button>
        </div>

        <div className="mt-4 text-[10px] text-[#4a5560] text-center">
          {t("info.tip_double_click")}
        </div>
      </div>
    </div>
  );
}
