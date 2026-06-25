// ConnectError — compact connection-failure card with a collapsible full log.
// Renders inside the failed tab's viewport (not a modal). Design handoff step 13.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X, ChevronRight, Copy, Check, RotateCcw, SquarePen } from "lucide-react";
import { Button } from "./components/primitives";
import { ParsedError } from "./connectError";

interface Props {
  host: string;
  parsed: ParsedError;
  onRetry: () => void;
  onEditHost: () => void;
  onClose: () => void;
}

export function ConnectError({ host, parsed, onRetry, onEditHost, onClose }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(parsed.fullLog);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard denied */
    }
  }

  const reason = parsed.causeKey ? t(parsed.causeKey) : parsed.reason;

  return (
    <div className="h-full grid place-items-center p-8 bg-nx-bg overflow-auto">
      <div
        className="relative w-[560px] max-w-full bg-nx-panel rounded-nx-lg overflow-hidden border border-[rgba(255,107,107,0.35)]
                   shadow-[inset_0_1px_0_rgba(255,107,107,0.08),0_20px_60px_rgba(0,0,0,0.6),0_0_40px_var(--nx-error-glow)]"
      >
        <span className="nx-brackets nx-brackets--error">
          <i />
        </span>
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1 text-nx-muted hover:text-nx-text z-10"
        >
          <X size={13} />
        </button>

        <div className="p-[22px]">
          {/* title */}
          <div className="flex items-center gap-2.5">
            <AlertTriangle size={16} className="text-nx-error shrink-0" />
            <div className="text-h3 text-nx-error font-medium">
              {t("connect_err.title")} <span className="text-nx-text">{host}</span>
            </div>
          </div>

          {/* short reason */}
          <div className="mt-3 flex gap-2.5 px-3 py-2.5 rounded-nx text-body text-nx-text bg-[rgba(255,107,107,0.06)] border border-[rgba(255,107,107,0.2)]">
            <span className="break-words">{reason}</span>
          </div>

          {/* disclosure */}
          <div className="mt-3.5">
            <button
              onClick={() => setOpen((o) => !o)}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-nx border border-nx-border bg-nx-bg text-body text-nx-dim hover:border-nx-dim hover:text-nx-text transition-colors"
            >
              <ChevronRight
                size={13}
                className={"transition-transform duration-150 " + (open ? "rotate-90" : "")}
              />
              <span>{t("connect_err.details")}</span>
              <span className="ml-auto text-micro text-nx-muted">
                {open ? t("connect_err.lines", { n: parsed.lineCount }) : t("connect_err.show")}
              </span>
            </button>

            {open && (
              <div className="mt-2.5 border border-nx-border rounded-nx bg-[#06090a]">
                <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-nx-divider">
                  <span className="text-micro uppercase tracking-[0.16em] text-nx-muted">
                    // {t("connect_err.log")}
                  </span>
                  <button
                    onClick={copyLog}
                    className={
                      "ml-auto inline-flex items-center gap-1.5 px-2 py-1 rounded border text-micro uppercase tracking-[0.08em] bg-nx-elevated " +
                      (copied
                        ? "text-nx-accent border-nx-accent"
                        : "text-nx-soft border-nx-border hover:text-nx-accent hover:border-nx-accent")
                    }
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? t("connect_err.copied") : t("connect_err.copy")}
                  </button>
                </div>
                <pre className="m-0 px-3 py-2.5 max-h-[220px] overflow-auto text-[11px] leading-[1.55] text-nx-dim whitespace-pre-wrap break-all">
                  {parsed.fullLog}
                </pre>
              </div>
            )}
          </div>

          {/* actions */}
          <div className="mt-[18px] flex items-center gap-2">
            <Button variant="primary" leadingIcon={<RotateCcw size={13} />} onClick={onRetry}>
              {t("connect_err.retry")}
            </Button>
            <Button variant="secondary" leadingIcon={<SquarePen size={13} />} onClick={onEditHost}>
              {t("connect_err.edit_host")}
            </Button>
            <button onClick={onClose} className="ml-auto text-meta text-nx-muted hover:text-nx-text">
              {t("connect_err.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
