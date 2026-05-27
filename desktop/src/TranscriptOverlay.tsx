// TranscriptOverlay — read-only scrollback view that overlays an active SSH
// tab when the user wants to scroll through history that xterm.js can't show
// in alt-screen mode (Claude Code / vim / htop / less / tmux).
//
// How it works:
//   * Live TerminalView keeps running underneath (its SSH session is alive
//     in the backend, bytes still flowing into the .cast file).
//   * On open we call historyReadEvents(sessionId) to fetch every chunk
//     the backend has logged so far for THIS session.
//   * We feed those bytes through filterAltBuffer (strips ESC[?1049h/l etc.)
//     into a hidden xterm.js instance, so all redraws accumulate in main
//     buffer scrollback — wheel scroll works there.
//   * Esc / Ctrl-Shift-Down dismisses the overlay; the live terminal is
//     immediately visible again with its current state intact.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, ArrowDown } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  historyReadEvents,
  filterAltBuffer,
  CastEvent,
} from "./history";
import { useSettings } from "./settings/settings-store";
import { THEMES, xtermThemeOf } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";

interface Props {
  sessionId: string;
  hostLabel: string;
  onClose: () => void;
}

export function TranscriptOverlay({ sessionId, hostLabel, onClose }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const palette = THEMES[settings.theme];
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [events, setEvents] = useState<CastEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load events for this session
  useEffect(() => {
    historyReadEvents(sessionId)
      .then(setEvents)
      .catch((e) => setError(String(e)));
  }, [sessionId]);

  // Init hidden xterm
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      theme: xtermThemeOf(palette),
      fontFamily: fontStackOf(settings.font),
      fontSize: settings.fontSize,
      cursorBlink: false,
      scrollback: 1_000_000,
      disableStdin: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Direct viewport scroll
    const vp = containerRef.current.querySelector(
      ".xterm-viewport",
    ) as HTMLElement | null;
    const wheelHandler = (ev: WheelEvent) => {
      if (!vp) return;
      vp.scrollTop += ev.deltaY;
      ev.preventDefault();
    };
    containerRef.current.addEventListener("wheel", wheelHandler, {
      passive: false,
    });

    const onWin = () => fit.fit();
    window.addEventListener("resize", onWin);

    return () => {
      window.removeEventListener("resize", onWin);
      containerRef.current?.removeEventListener("wheel", wheelHandler);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replay events into hidden xterm whenever events change
  useEffect(() => {
    const term = termRef.current;
    if (!term || !events) return;
    term.reset();
    fitRef.current?.fit();
    let prev = "";
    const writeChunk = (s: string) => {
      const parts = s.split(/(\r\n|\n)/);
      for (let i = 0; i < parts.length; i += 2) {
        const line = parts[i];
        const sep = parts[i + 1] ?? "";
        if (line && sep && line === prev) continue;
        term.write(line + sep);
        if (sep) prev = line;
      }
    };
    for (const ev of events) {
      writeChunk(filterAltBuffer(ev.d));
    }
    // Scroll to BOTTOM so user sees the latest output first; they can wheel
    // up to inspect older content. Same UX as terminal scrollback.
    requestAnimationFrame(() => {
      term.scrollToBottom();
    });
  }, [events]);

  // Apply theme/font changes live
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeOf(palette);
    term.options.fontFamily = fontStackOf(settings.font);
    term.options.fontSize = settings.fontSize;
    type WithClear = { clearTextureAtlas?: () => void };
    (term as unknown as WithClear).clearTextureAtlas?.();
    term.refresh(0, term.rows - 1);
  }, [settings.theme, settings.font, settings.fontSize, palette]);

  // Esc to close, Ctrl-Shift-Down also closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        (e.key === "ArrowDown" || e.key === "Down")
      ) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[var(--nx-bg-base)]">
      <div
        className="h-9 shrink-0 flex items-center px-3 border-b font-mono text-xs"
        style={{
          background: palette.bgSecondary,
          borderColor: palette.border,
          color: palette.textSoft,
        }}
      >
        <span className="text-[var(--nx-accent)]">&gt;</span>
        <span className="ml-2">
          {t("transcript.title", { host: hostLabel })}
        </span>
        <span className="ml-3 text-[var(--nx-text-muted)] italic">
          {t("transcript.hint")}
        </span>
        <button
          onClick={onClose}
          title={t("transcript.return")}
          className="ml-auto px-2 py-0.5 rounded flex items-center gap-1.5 hover:bg-[var(--nx-bg-elevated)] text-[var(--nx-text-soft)]"
        >
          <ArrowDown size={12} />
          <span>{t("transcript.return_short")}</span>
        </button>
        <button
          onClick={onClose}
          className="ml-2 p-1 rounded hover:bg-[var(--nx-bg-elevated)] text-[var(--nx-text-soft)]"
        >
          <X size={14} />
        </button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
      {error && (
        <div className="px-3 py-1 text-xs font-mono text-[var(--nx-error)]">
          ✗ {error}
        </div>
      )}
    </div>
  );
}
