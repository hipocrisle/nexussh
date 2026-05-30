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
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  historyReadEvents,
  filterAltBuffer,
  CastEvent,
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

    const onWin = () => fit.fit();
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

  // Replay events. Two-pass strategy for noisy TUI sessions
  // (claude-code, htop, tmux): the cast file stores TUI redraws byte-for-byte
  // mixed with content, so the naive xterm replay either shows alt-screen
  // (no scrollback) or floods scrollback with TUI fossils.
  //
  // Pass 1 — feed bytes (with alt-screen toggles stripped) into a HEADLESS
  //   xterm at a wide grid (no fixed cols/rows constraint) and let it
  //   process all positioning natively. Lines that scroll out of the visible
  //   region accumulate in main-buffer scrollback. Serialize the whole
  //   scrollback as ANSI text to preserve colors.
  //
  // Pass 2 — dedup. Hash each line by its TEXT CONTENT only (strip ANSI,
  //   normalize spaces, drop pure digit/colon runs that look like clocks).
  //   Drop lines whose content hash appears MORE THAN TWICE in the whole
  //   scrollback — that's how tmux clock / claude TUI / status spinners
  //   manifest. Also drop consecutive identical lines.
  //
  // Pass 3 — write the resulting ANSI lines back to the VISIBLE xterm
  //   (with colors), scroll to bottom. User wheels up through clean content.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !events) return;
    term.reset();
    fitRef.current?.fit();

    // Pass 1: headless processor.
    const headless = new HeadlessTerminal({
      cols: Math.max(term.cols, 200), // wide so long lines don't wrap weirdly
      rows: term.rows,
      scrollback: 1_000_000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    headless.loadAddon(serializer);
    for (const ev of events) {
      headless.write(filterAltBuffer(ev.d));
    }

    // Serialize with scrollback so we capture everything that scrolled out.
    const ansi = serializer.serialize({ scrollback: 1_000_000 });
    headless.dispose();

    // Pass 2: dedup by content hash.
    const stripAnsi = (s: string) =>
      // CSI / OSC / single-byte ESC sequences — strip for hashing only.
      s.replace(/\x1b\[[\d;?]*[ -\/]*[@-~]/g, "")
        .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "")
        .replace(/\x1b./g, "");
    const norm = (s: string) =>
      // Normalize for hashing — strip ANSI, collapse whitespace, drop
      // common time/clock patterns ("00:45", "1m 23s", "↓ 2.5k tokens",
      // "(7s · ↓ ...)") that change between TUI redraws.
      stripAnsi(s)
        .replace(/\d+/g, "#")
        .replace(/\s+/g, " ")
        .trim();

    const rawLines = ansi.split(/\r?\n/);
    const hashCount = new Map<string, number>();
    for (const ln of rawLines) {
      const h = norm(ln);
      if (h === "") continue;
      hashCount.set(h, (hashCount.get(h) ?? 0) + 1);
    }

    const outLines: string[] = [];
    let prevHash = "";
    let blankRun = 0;
    for (const ln of rawLines) {
      const h = norm(ln);
      // Collapse runs of blank lines to at most one.
      if (h === "") {
        blankRun++;
        if (blankRun <= 1) outLines.push(ln);
        continue;
      }
      blankRun = 0;
      // TUI fossil: same content (modulo digits/spaces) seen more than twice.
      if ((hashCount.get(h) ?? 0) > 2) continue;
      // Consecutive identical lines — keep one.
      if (h === prevHash) continue;
      outLines.push(ln);
      prevHash = h;
    }

    // Pass 3: write the cleaned ANSI stream back to the visible xterm.
    term.write(outLines.join("\r\n") + "\r\n");
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
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
      {error && (
        <div className="px-3 py-1 text-xs font-mono text-[var(--nx-error)]">
          ✗ {error}
        </div>
      )}
    </div>
  );
}
