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
  isTmuxStatusLine,
  isClaudeChromeLine,
  extractClaudeConversation,
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
  // Default to plain-text mode — the ANSI replay strips alt-screen
  // windows entirely (TUI redraws there can't be cleanly replayed into
  // the main buffer), and almost every long session has Claude Code /
  // vim / htop inside, so default-ANSI ends up empty. Plain text shows
  // everything readably. User can flip back when they want colors and
  // know the recording is plain-shell.
  const PLAIN_LS_KEY = "nexussh.transcriptPlainText";
  const CONV_LS_KEY = "nexussh.transcriptConvOnly";
  const [convOnly, setConvOnly] = useState<boolean>(() => {
    const v = localStorage.getItem(CONV_LS_KEY);
    return v === null ? true : v === "1";
  });
  const [plainText, setPlainText] = useState<boolean>(() => {
    const v = localStorage.getItem(PLAIN_LS_KEY);
    return v === null ? true : v === "1";
  });

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

  // Replay events into hidden xterm whenever events change.
  //
  // Concatenate ALL events first, then filter — alt-screen windows from
  // Claude Code / vim / htop can easily span hundreds of small chunks,
  // and per-event filtering can't see the closing `\x1b[?1049l` if it's
  // in a later chunk. Once that whole alt-screen body is gone, we feed
  // the remainder line-by-line (skipping tmux status redraws).
  //
  // The line-dedup that lived here ("if (line === prev) continue") was
  // dropping legitimate consecutive identical output too aggressively —
  // also removed.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !events) return;
    term.reset();
    fitRef.current?.fit();
    const full = events.map((e) => e.d).join("");

    if (plainText) {
      // Plain mode = REAL replay through an offscreen xterm.
      //
      // Why this beats regex stripping: Claude Code (and similar TUIs)
      // animate the spinner character-by-character with cursor jumps
      // between non-adjacent columns and colour escapes per cell. Any
      // line-by-line stripper turns that into "lesенka / single-char
      // fragments / weird columns of letters". A real terminal emulator
      // just overwrites the same cells frame after frame, so the final
      // buffer state is exactly what a human would see if they scrolled
      // back in the live session.
      //
      // We strip the alt-screen toggles so the TUI paints into main
      // buffer (with scrollback) instead of the small alt buffer that
      // gets thrown away on exit.
      const noAlt = full.replace(/\x1b\[\?(?:1049|1048|1047|47)[hl]/g, "");
      // Replay at a deliberately WIDE width. The recorded bytes were laid
      // out at the *server-side* render width — which, when the session
      // runs inside tmux, is tmux's window width (often 80-120), NOT the
      // narrow SSH-PTY width the phone reported. Replaying narrower than the
      // baked content width re-wraps every line mid-word ("garbage");
      // replaying wider is always safe (absolute cursor positions land
      // correctly, baked newlines are preserved). 220 exceeds any realistic
      // tmux window on phone/laptop. The visible terminal then soft-wraps
      // these clean lines to the panel width.
      const REPLAY_COLS = 220;
      const off = new Terminal({
        cols: REPLAY_COLS,
        rows: 50,
        scrollback: 100000,
        allowProposedApi: true,
        convertEol: false,
      });
      off.write(noAlt, () => {
        const buf = off.buffer.active;
        const rawLines: string[] = [];
        for (let i = 0; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (ln) rawLines.push(ln.translateToString(true));
        }
        off.dispose();
        // Sliding-window dedup + Claude Code chrome filter on top.
        const WINDOW = 200;
        const recentSet = new Set<string>();
        const recentList: string[] = [];
        const out: string[] = [];
        for (const ln of rawLines) {
          if (isClaudeChromeLine(ln)) continue;
          if (ln.trim() === "") {
            if (out.length === 0 || out[out.length - 1] !== "") out.push("");
            continue;
          }
          if (recentSet.has(ln)) continue;
          out.push(ln);
          recentSet.add(ln);
          recentList.push(ln);
          if (recentList.length > WINDOW) {
            const ev = recentList.shift()!;
            recentSet.delete(ev);
          }
        }
        while (out.length && !out[out.length - 1]) out.pop();
        const finalLines = convOnly ? extractClaudeConversation(out) : out;
        term.write(finalLines.join("\r\n"));
        requestAnimationFrame(() => term.scrollToBottom());
      });
      return;
    }

    // Color mode: drop the whole alt-screen window and let xterm render
    // the rest with color.
    const cleaned = filterAltBuffer(full);
    const parts = cleaned.split(/(\r\n|\n)/);
    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i];
      const sep = parts[i + 1] ?? "";
      if (line && sep && isTmuxStatusLine(line)) continue;
      term.write(line + sep);
    }
    // Scroll to BOTTOM so user sees the latest output first; they can wheel
    // up to inspect older content. Same UX as terminal scrollback.
    requestAnimationFrame(() => {
      term.scrollToBottom();
    });
  }, [events, plainText, convOnly]);

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
          onClick={() => {
            const next = !convOnly;
            setConvOnly(next);
            localStorage.setItem(CONV_LS_KEY, next ? "1" : "0");
          }}
          title={t("transcript.conv_hint")}
          disabled={!plainText}
          className={
            "ml-auto mr-2 px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider border disabled:opacity-30 " +
            (convOnly && plainText
              ? "bg-[var(--nx-accent-glow)] text-[var(--nx-accent)] border-[var(--nx-accent)]"
              : "border-[var(--nx-border)] text-[var(--nx-text-soft)] hover:bg-[var(--nx-bg-elevated)]")
          }
        >
          {convOnly ? t("transcript.conv_on") : t("transcript.conv_off")}
        </button>
        <button
          onClick={() => {
            const next = !plainText;
            setPlainText(next);
            localStorage.setItem(PLAIN_LS_KEY, next ? "1" : "0");
          }}
          title={t("transcript.plain_hint")}
          className={
            "mr-2 px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider border " +
            (plainText
              ? "bg-[var(--nx-accent-glow)] text-[var(--nx-accent)] border-[var(--nx-accent)]"
              : "border-[var(--nx-border)] text-[var(--nx-text-soft)] hover:bg-[var(--nx-bg-elevated)]")
          }
        >
          {plainText ? t("transcript.plain_on") : t("transcript.plain_off")}
        </button>
        <button
          onClick={onClose}
          title={t("transcript.return")}
          className="px-2 py-0.5 rounded flex items-center gap-1.5 hover:bg-[var(--nx-bg-elevated)] text-[var(--nx-text-soft)]"
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
