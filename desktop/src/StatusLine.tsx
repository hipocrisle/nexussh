// StatusLine — tmux/vim-style bottom strip (22px).
// Shows: mode · session counts · utf-8 · ssh-2.0 · clock.
// Adapted to NexuSSH's actual session model (statuses connecting/connected/
// closed; no per-session cwd yet).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  sessionCount: number;
  connectingCount: number;
  /** Focused session, for the per-session segment. */
  activeHost?: string | null;
  activeStatus?: "connecting" | "connected" | "closed" | null;
  /** Human label of the VPN the focused session routes through (any type), or
   *  null for a direct connection. */
  activeVpnLabel?: string | null;
  activeVpnExit?: string | null;
}

export function StatusLine({
  sessionCount,
  connectingCount,
  activeHost = null,
  activeStatus = null,
  activeVpnLabel = null,
  activeVpnExit = null,
}: Props) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="nx-safe-bottom h-[22px] px-3 flex items-center gap-4 bg-nx-bg-2 border-t border-nx-border text-micro text-nx-muted uppercase tracking-[0.12em] shrink-0">
      <span className="flex items-center gap-1.5 text-nx-accent">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-nx-accent shadow-[0_0_8px_var(--nx-accent-glow)]" />
        {t("status.mode_normal")}
      </span>

      <span>
        {t("status.sessions", { n: sessionCount })}
        {connectingCount > 0 && (
          <span className="text-nx-warning">
            {" "}
            · {connectingCount} {t("status.connecting")}
          </span>
        )}
      </span>

      {activeHost && (
        <span className="flex items-center gap-1.5 min-w-0 normal-case tracking-normal">
          <span className="truncate max-w-[40ch] text-nx-text">{activeHost}</span>
          <span
            className={
              activeStatus === "connected"
                ? "text-nx-accent"
                : activeStatus === "connecting"
                  ? "text-nx-warning"
                  : "text-nx-muted"
            }
          >
            · {t(`status.conn_${activeStatus ?? "closed"}`)}
          </span>
          <span className={activeVpnLabel ? "text-nx-accent" : "text-nx-muted"}>
            · {activeVpnLabel
              ? `⛨ ${activeVpnLabel}${activeVpnExit ? ` (${activeVpnExit})` : ""}`
              : t("status.direct")}
          </span>
        </span>
      )}

      <span className="ml-auto flex items-center gap-4">
        <span>utf-8</span>
        <span>ssh-2.0</span>
        <span className="tabular-nums">{now.toLocaleTimeString("en-GB")}</span>
      </span>
    </div>
  );
}
