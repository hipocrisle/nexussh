// Live, non-blocking status card for the OpenConnect (AnyConnect) VPN tunnel.
// Purely event-driven (like BackendProgress) — the Rust `establish_corp_tunnel`
// emits `corp-vpn-status` lifecycle events (connecting / up / error) and streams
// openconnect's own output on `corp-vpn-log`. This gives the user real insight
// into whether the tunnel came up and, on failure, the exact reason — instead of
// a downstream "host unreachable". It's a corner card (NOT a scrim) so it never
// blocks the password prompt that runs alongside the connect.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";

type Phase = "connecting" | "up" | "error";

interface StatusEvt {
  phase: Phase;
  server?: string;
  reason?: string;
}

export function CorpVpnStatus() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [server, setServer] = useState("");
  const [reason, setReason] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const clearHide = () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
    const unStatus = listen<StatusEvt>("corp-vpn-status", (e) => {
      const d = e.payload;
      clearHide();
      setPhase(d.phase);
      if (d.phase === "connecting") {
        setServer(d.server || "");
        setReason("");
        setLog([]);
      } else if (d.phase === "up") {
        // Tunnel established — flash the confirmation briefly, then fade out.
        hideTimer.current = window.setTimeout(() => setPhase(null), 2500);
      } else if (d.phase === "error") {
        setReason(d.reason || "");
        // Keep the failure visible a while (the reason also shows in the
        // session error), then auto-dismiss.
        hideTimer.current = window.setTimeout(() => setPhase(null), 10000);
      }
    });
    const unLog = listen<{ line: string }>("corp-vpn-log", (e) => {
      // Keep only the tail — openconnect is chatty (rekeys etc.).
      setLog((prev) => [...prev, e.payload.line].slice(-6));
    });
    return () => {
      clearHide();
      unStatus.then((f) => f());
      unLog.then((f) => f());
    };
  }, []);

  if (!phase) return null;

  const tone =
    phase === "error"
      ? "border-nx-error/50"
      : phase === "up"
        ? "border-nx-ok/50"
        : "border-nx-accent/40";

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-[360px] max-w-[92vw] pointer-events-none">
      <div
        className={`nx-modal-enter bg-nx-panel/95 backdrop-blur rounded-nx-lg p-4 shadow-elev-modal border ${tone}`}
      >
        <div className="flex items-center gap-2 font-mono">
          {phase === "connecting" && (
            <Loader2 size={15} className="text-nx-accent animate-spin" />
          )}
          {phase === "up" && <ShieldCheck size={15} className="text-nx-ok" />}
          {phase === "error" && (
            <ShieldAlert size={15} className="text-nx-error" />
          )}
          <span className="text-lead">
            {phase === "connecting" && t("corpvpn.connecting")}
            {phase === "up" && t("corpvpn.up")}
            {phase === "error" && t("corpvpn.failed")}
          </span>
        </div>
        {phase === "connecting" && server && (
          <div className="text-meta text-nx-muted font-mono mt-1 truncate">
            {server}
          </div>
        )}
        {phase === "error" && reason && (
          <div className="text-meta text-nx-error font-mono mt-1">{reason}</div>
        )}
        {log.length > 0 && phase !== "up" && (
          <div className="mt-2 max-h-24 overflow-hidden text-micro font-mono text-nx-soft leading-relaxed">
            {log.map((l, i) => (
              <div key={i} className="truncate opacity-80">
                {l}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
