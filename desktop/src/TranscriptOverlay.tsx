// TranscriptOverlay — read-only scrollback view that overlays an active SSH
// tab when the user wants to scroll through history of the session.
//
// How it works:
//   * Live TerminalView keeps running underneath (its SSH session is alive
//     in the backend, bytes still flowing into the .cast file).
//   * On open we call historyReadEvents(sessionId) to fetch every chunk
//     the backend has logged so far for THIS session, plus the original
//     cols/rows the session was authored at.
//   * We resize the replay xterm to those exact cols so ESC[K, absolute
//     positioning and line wrap compute against the SAME column count the
//     bytes were emitted for — otherwise text "shifts".
//   * Bytes are written raw (only ESC[3J scrollback-wipe is stripped) so
//     xterm.js handles alt-screen natively: vim/htop episodes live in the
//     alt buffer; main-buffer scrollback shows the rest of the session
//     cleanly without corruption from interleaved alt-screen positioning.
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
  sanitizeReplayChunk,
  CastReplay,
} from "./history";
import { useSettings } from "./settings/settings-store";
import { THEMES, xtermThemeOf } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";

// Local copy of the useSettings hook for the read-only transcript view —
// only needs to react to puttyMouse / theme / font changes.

interface MenuItem {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface Props {
  sessionId: string;
  hostLabel: string;
  onClose: () => void;
  onContextMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

export function TranscriptOverlay({
  sessionId,
  hostLabel,
  onClose,
  onContextMenu,
}: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const palette = THEMES[settings.theme];
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const replayColsRef = useRef<number>(0);
  const [replay, setReplay] = useState<CastReplay | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load events + original session dims for this session
  useEffect(() => {
    historyReadEvents(sessionId)
      .then(setReplay)
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

    // Direct viewport scroll — capture phase to win over xterm.
    const vp = containerRef.current.querySelector(
      ".xterm-viewport",
    ) as HTMLElement | null;
    const wheelHandler = (ev: WheelEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (vp) vp.scrollTop += ev.deltaY;
    };
    containerRef.current.addEventListener("wheel", wheelHandler, {
      passive: false,
      capture: true,
    });

    // PuTTY-style auto-copy on selection release. Read-only view so no
    // paste branch.
    const mouseupHandler = () => {
      if (!settingsRef.current.puttyMouse) return;
      setTimeout(() => {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      }, 0);
    };
    containerRef.current.addEventListener("mouseup", mouseupHandler);

    // Right-click → Copy / Select All (no Paste — read-only)
    const ctxHandler = (ev: MouseEvent) => {
      ev.preventDefault();
      const selection = term.getSelection();
      const items: MenuItem[] = [
        {
          label: t("term_menu.copy"),
          disabled: !selection,
          onClick: () => {
            if (!selection) return;
            navigator.clipboard.writeText(selection).catch(console.error);
          },
        },
        {
          label: t("term_menu.select_all"),
          onClick: () => term.selectAll(),
        },
      ];
      onContextMenuRef.current?.(ev.clientX, ev.clientY, items);
    };
    containerRef.current.addEventListener("contextmenu", ctxHandler);

    // Keyboard shortcuts at the xterm level so they never leak to anything
    // beneath: Ctrl+Shift+C (copy), Esc + Ctrl+Shift+Down (close overlay).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.key === "Escape") {
        onCloseRef.current();
        return false;
      }
      const ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
      if (ctrlShift && (ev.key === "ArrowDown" || ev.key === "Down")) {
        onCloseRef.current();
        return false;
      }
      if (ctrlShift && ev.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      return true;
    });

    // On window resize: re-fit but pin cols to the original replay width so
    // recorded bytes keep wrapping where they were authored. fit.fit() would
    // otherwise re-pick cols from the new container width and shift the text.
    const onWin = () => {
      fit.fit();
      const pinned = replayColsRef.current;
      if (pinned > 0 && term.cols !== pinned) {
        term.resize(pinned, term.rows);
      }
    };
    window.addEventListener("resize", onWin);

    return () => {
      window.removeEventListener("resize", onWin);
      containerRef.current?.removeEventListener("wheel", wheelHandler, true as any);
      containerRef.current?.removeEventListener("contextmenu", ctxHandler);
      containerRef.current?.removeEventListener("mouseup", mouseupHandler);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replay events into hidden xterm whenever events change.
  // Key: resize the terminal to the ORIGINAL session's cols (and at least
  // its rows) BEFORE writing so all ESC sequences operate against the same
  // column count the bytes were authored for. Otherwise text shifts and
  // wraps at the wrong points.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !replay) return;
    term.reset();
    fitRef.current?.fit();
    if (replay.cols > 0 && replay.rows > 0) {
      const rows = Math.max(replay.rows, term.rows);
      term.resize(replay.cols, rows);
      replayColsRef.current = replay.cols;
    } else {
      replayColsRef.current = 0;
    }
    for (const ev of replay.events) {
      term.write(sanitizeReplayChunk(ev.d));
    }
    // Scroll to BOTTOM so user sees the latest output first; they can wheel
    // up to inspect older content. Same UX as terminal scrollback.
    requestAnimationFrame(() => {
      term.scrollToBottom();
    });
  }, [replay]);

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

  // Capture-phase keydown as a fallback in case xterm doesn't have focus —
  // e.g. user clicked outside the embedded terminal canvas onto the header.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        (e.key === "ArrowDown" || e.key === "Down")
      ) {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

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
      {/* overflow-x: auto so a session wider than the overlay (rare —
       *  mostly happens in split-view panes) gets a horizontal scrollbar
       *  instead of clipping. xterm.js handles vertical scrollback itself. */}
      <div ref={containerRef} className="flex-1 min-h-0 p-1 overflow-x-auto" />
      {error && (
        <div className="px-3 py-1 text-xs font-mono text-[var(--nx-error)]">
          ✗ {error}
        </div>
      )}
    </div>
  );
}
