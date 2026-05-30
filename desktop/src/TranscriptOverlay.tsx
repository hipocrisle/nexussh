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

  // Replay events. Strategy:
  //
  //   1. Concatenate all cast bytes (with filterAltBuffer applied: strip
  //      alt-screen toggles + ESC[3J — same as v0.0.20). This gives us
  //      a single linear ANSI-text stream.
  //   2. Strip ANSI. Split by lines.
  //   3. Detect claude-code session (any line starts with "●" — claude's
  //      AI-response marker that prefixes every assistant message).
  //   4. If claude-code mode: walk lines, extract content blocks. A block
  //      starts on a "●"-prefixed line and continues through subsequent
  //      indented lines (2-space indent — claude-code's continuation
  //      convention) and blank lines, until a non-claude line is hit
  //      (like ❯ user input, status text, TUI panel rows).
  //   5. Write the extracted blocks linearly into the visible xterm.
  //
  //   If no "●" markers present (regular SSH, vim, etc.): fall through to
  //   the classic raw replay so non-claude sessions still work.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !events) return;
    term.reset();
    fitRef.current?.fit();

    // Concatenate and apply byte-level filter.
    const allText = events.map((e) => filterAltBuffer(e.d)).join("");

    // Strip ANSI for content detection. We keep a parallel "ansi" version
    // so we can write the original styled lines, not stripped ones.
    const stripAnsi = (s: string) =>
      s.replace(/\x1b\[[\d;?]*[ -\/]*[@-~]/g, "")
        .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "")
        .replace(/\x1b./g, "");

    // Split by linefeed. \r without \n is a redraw artifact — collapse runs
    // by keeping the LAST segment after the last \r on a logical line.
    const lines: string[] = []; // ANSI-preserving lines
    const plain: string[] = []; // stripped for matching
    for (const rawLine of allText.split("\n")) {
      // Take final segment after any \r — that's the last "frame" of a
      // line that got redrawn in place (status bar / spinner updates).
      const segments = rawLine.split("\r");
      const finalAnsi = segments[segments.length - 1];
      lines.push(finalAnsi);
      plain.push(stripAnsi(finalAnsi));
    }

    // Detect claude-code session: any plain line containing "●" as the
    // first non-space character.
    const claudeRe = /^\s*●/;
    const isClaudeSession = plain.some((p) => claudeRe.test(p));

    let outLines: string[];
    if (isClaudeSession) {
      // Pass: extract AI-response blocks.
      outLines = [];
      let inBlock = false;
      for (let i = 0; i < plain.length; i++) {
        const p = plain[i];
        const trimmed = p.trim();
        if (claudeRe.test(p)) {
          // Block start. Emit a separator if we have prior content.
          if (outLines.length > 0) outLines.push("");
          outLines.push(lines[i]);
          inBlock = true;
          continue;
        }
        if (inBlock) {
          // Continue block if: indented continuation, or blank line.
          if (trimmed === "" || /^( {2,}|\t)/.test(p)) {
            outLines.push(lines[i]);
            continue;
          }
          // Otherwise: block ended (user prompt ❯, status, TUI row).
          inBlock = false;
        }
        // Outside block: also surface user prompts (lines starting with ❯)
        // so the conversation flow is readable.
        if (/^\s*❯/.test(p) && trimmed.length > 2) {
          if (outLines.length > 0 && outLines[outLines.length - 1] !== "")
            outLines.push("");
          outLines.push(lines[i]);
        }
      }
    } else {
      // No claude markers — classic v0.0.20 replay with consecutive dedup.
      outLines = [];
      let prev = "";
      for (let i = 0; i < lines.length; i++) {
        const p = plain[i];
        if (p && p === prev) continue;
        outLines.push(lines[i]);
        if (p) prev = p;
      }
    }

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
