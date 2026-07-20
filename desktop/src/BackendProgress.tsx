// Global overlay shown while an on-demand VPN backend (openconnect, ...) is being
// downloaded. It's purely event-driven — any caller of ensureVpnBackend() makes
// it appear, no prop threading. Auto-hides on the terminal "done"/"error" event.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Download } from "lucide-react";

interface Prog {
  id: string;
  file: string;
  fileIdx: number;
  fileCount: number;
  bytes: number;
  bytesTotal: number;
  phase: string;
}

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} МБ`;
}

export function BackendProgress() {
  const { t } = useTranslation();
  const [p, setP] = useState<Prog | null>(null);

  useEffect(() => {
    const un = listen<Prog>("backend-progress", (e) => {
      const d = e.payload;
      if (d.phase === "done" || d.phase === "error") {
        setP(null);
      } else {
        setP(d);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  if (!p) return null;
  // Overall progress across all files: completed files + fraction of current one.
  const frac = p.bytesTotal > 0 ? p.bytes / p.bytesTotal : 0;
  const pct = p.fileCount
    ? Math.round(((p.fileIdx + frac) / p.fileCount) * 100)
    : 0;

  return (
    <div className="nx-scrim grid place-items-center">
      <div className="nx-modal-enter w-[380px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal">
        <div className="flex items-center gap-2 mb-1 text-nx-accent font-mono">
          <Download size={15} />
          <span className="text-lead">{t("backend.title")}</span>
        </div>
        <div className="text-meta text-nx-muted font-mono mb-3">{t("backend.hint")}</div>
        <div className="flex items-center justify-between text-micro font-mono text-nx-soft mb-2">
          <span className="truncate mr-2">
            {p.file || "…"} · {p.fileIdx + 1}/{p.fileCount}
          </span>
          {p.bytesTotal > 0 && (
            <span className="shrink-0">
              {mb(p.bytes)} / {mb(p.bytesTotal)}
            </span>
          )}
        </div>
        <div className="h-1.5 rounded overflow-hidden bg-nx-divider">
          <div
            className="h-full bg-nx-accent transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
