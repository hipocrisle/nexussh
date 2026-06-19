// Terminal component: wraps xterm.js, wires to our Tauri SSH commands.
// One instance per session — kept mounted while the tab exists; visibility
// is toggled by parent via CSS so xterm state persists across tab switches.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon, ISearchOptions } from "@xterm/addon-search";
import { Search, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  sshSend,
  sshResize,
  sshDisconnect,
  sshReady,
  onSshData,
  onSshClosed,
} from "./ssh";
import { useSettings } from "./settings/settings-store";
import { THEMES, xtermThemeOf } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";
import { readClipboard, writeClipboard } from "./clipboard";
import { useIsMobile } from "./useIsMobile";

export interface TerminalAction {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

// Fit ONLY when the container is genuinely visible with a real-sized box.
// A hidden tab (display:none) reports offsetParent=null / offsetWidth=0, and
// during layout transitions the box can briefly measure tiny. Fitting then
// resizes xterm to a handful of columns; the PTY reflows its output narrow,
// and those hard-wrapped lines stay broken even after the width is restored
// (the "text in a column" bug when switching tabs repeatedly).
function fitIfVisible(el: HTMLElement | null, fit: FitAddon | null) {
  if (!el || !fit) return;
  if (!el.offsetParent || el.offsetWidth < 80 || el.offsetHeight < 40) return;
  fit.fit();
}

// Snapshot the terminal buffer (capped to the last 10k lines) as plain text for
// the mobile copy-mode overlay.
function bufferToText(term: Terminal): string {
  const buf = term.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - 10000);
  const lines: string[] = [];
  for (let i = start; i < total; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n").replace(/\s+$/, "");
}

interface Props {
  sessionId: string;
  visible: boolean;
  /** Called when the SSH session ends (remote close / disconnect / error). */
  onSessionClosed?: (reason: string) => void;
  /** Parent renders the context menu — we just emit position + items. */
  onContextMenu?: (x: number, y: number, items: TerminalAction[]) => void;
  /** Reconnect this tab — invoked when the user presses Enter in a session
   *  that has already closed (PuTTY-style). */
  onReconnect?: () => void;
}

export function TerminalView({
  sessionId,
  visible,
  onSessionClosed,
  onContextMenu,
  onReconnect,
}: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  // On mobile, programmatic term.focus() pops the soft keyboard on every tab
  // switch / reconnect ("при любом чихе"). Suppress auto-focus there; the
  // keyboard is shown only by the ⌨ bar key or a deliberate tap on the terminal.
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // True once the session has closed — gates the Enter-to-reconnect shortcut.
  const closedRef = useRef(false);
  // Keep latest t() in a ref so the mount-once effect always gets fresh translation
  const tRef = useRef(t);
  tRef.current = t;
  // Same for onContextMenu — we want the LATEST callback when the user
  // right-clicks, but we register the listener once at mount.
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  // Latest settings via ref so the mount-once effects pick up changes to
  // settings.puttyMouse without resubscribing every render.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ── In-terminal find (Ctrl+F / 🔍 button) ──────────────────────────────
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findInfo, setFindInfo] = useState<{ idx: number; count: number }>({
    idx: -1,
    count: 0,
  });
  // Mobile copy-mode: the terminal buffer rendered as plain selectable text so
  // native selection (with handles) + the system copy toolbar work — xterm's own
  // text can't be selected in place.
  const [copyMode, setCopyMode] = useState(false);
  const [copyText, setCopyText] = useState("");
  const copyPreRef = useRef<HTMLPreElement>(null);
  // Track `visible` for the (window-level) copy-mode trigger so only the focused
  // terminal responds.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const palette = THEMES[settings.theme];
  // Outline-only decorations (a fill over coloured glyphs is unreadable).
  const searchOpts: ISearchOptions = {
    decorations: {
      matchBorder: `${palette.accent2}99`,
      matchOverviewRuler: palette.accent2,
      activeMatchBorder: `${palette.warning}aa`,
      activeMatchColorOverviewRuler: palette.warning,
    },
  };
  const searchOptsRef = useRef(searchOpts);
  searchOptsRef.current = searchOpts;
  // Refs so the mount-once key handler / window listener get fresh setters.
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;
  const openFindRef = useRef<() => void>(() => {});
  openFindRef.current = () => {
    setFindOpen(true);
    requestAnimationFrame(() => findInputRef.current?.focus());
  };
  function closeFind() {
    setFindOpen(false);
    setFindQuery("");
    setFindInfo({ idx: -1, count: 0 });
    searchAddorClear();
    // Drop the lingering find-match selection so it can't be copied afterwards.
    termRef.current?.clearSelection();
    termRef.current?.focus();
  }
  function searchAddorClear() {
    searchAddonRef.current?.clearDecorations?.();
  }
  const closeFindRef = useRef<() => void>(() => {});
  closeFindRef.current = closeFind;
  function runFind(forward: boolean) {
    const a = searchAddonRef.current;
    if (!a || !findQuery) return;
    if (forward) a.findNext(findQuery, searchOptsRef.current);
    else a.findPrevious(findQuery, searchOptsRef.current);
  }

  // Initialize terminal once per session — uses INITIAL settings; later
  // changes are pushed via the effects below.
  useEffect(() => {
    if (!containerRef.current) return;
    const initialTheme = THEMES[settings.theme];

    // Adapt scrollback to device memory. xterm allocates per-line state for
    // every entry in scrollback. On low-RAM devices (mobile, older laptops)
    // 100k lines × N sessions blows the heap.
    // navigator.deviceMemory is in GB; Chromium-based WebView2/Android
    // WebView exposes it. Older WebKitGTK returns undefined → assume desktop.
    const mem = (navigator as { deviceMemory?: number }).deviceMemory;
    const scrollbackLines =
      mem !== undefined && mem < 4 ? 30_000 : 100_000;

    const term = new Terminal({
      theme: xtermThemeOf(initialTheme),
      fontFamily: fontStackOf(settings.font),
      fontSize: settings.fontSize,
      cursorBlink: true,
      scrollback: scrollbackLines,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    const searchResultsDisposable = searchAddon.onDidChangeResults(
      ({ resultIndex, resultCount }) =>
        setFindInfo({ idx: resultIndex, count: resultCount }),
    );
    term.open(containerRef.current);
    fitIfVisible(containerRef.current, fit);
    termRef.current = term;
    fitRef.current = fit;

    // Mobile: declare the hidden input as inputmode="none" so the soft keyboard
    // never auto-pops — not on focus, not on a bar-key tap, not on a stray touch
    // ("выскакивает при любом чихе"). The ⌨ bar key flips it to "text" to type;
    // any blur resets it back to "none" so it can't sneak back.
    if (isMobileRef.current) {
      const ta = containerRef.current.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (ta) {
        ta.inputMode = "none";
        ta.addEventListener("blur", () => {
          ta.inputMode = "none";
        });
      }
    }

    // Wheel scroll — CAPTURE phase listener so we run BEFORE xterm's own
    // wheel handler. In main buffer we scroll the viewport directly. In
    // alt-screen mode (Claude Code, vim, htop, less) xterm's default would
    // translate wheel into ESC[OA/B and send to the PTY, which makes the
    // remote app think the user is hitting arrow keys — input cursors move,
    // shell history scrolls, etc. That's confusing; we kill the event there.
    const viewport = containerRef.current.querySelector(
      ".xterm-viewport",
    ) as HTMLElement | null;
    const wheelHandler = (ev: WheelEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const altBuf = term.buffer.active.type === "alternate";
      if (altBuf) return; // alt-screen has no scrollback; do NOT forward
      if (viewport) viewport.scrollTop += ev.deltaY;
    };
    containerRef.current.addEventListener("wheel", wheelHandler, {
      passive: false,
      capture: true,
    });

    // ── Mobile touch ──────────────────────────────────────────────────────
    // xterm scrolls the MAIN buffer on touch itself (Viewport.handleTouchStart).
    // In ALT-screen (Claude Code/less/vim — app mouse mode, xterm skips its own
    // touch-scroll) we turn a swipe into Up/Down arrows so the TUI scrolls.
    //
    // Text SELECTION on mobile is a SEPARATE copy-mode overlay (see below): the
    // xterm text itself can't be selected in place — `.xterm` is user-select:none
    // and the .xterm-viewport overlays the rows — so we render the buffer text in
    // a plain selectable <pre> where native selection + handles + the system copy
    // toolbar just work.
    let touchActive = false;
    let lastTouchY = 0;
    let touchAccum = 0;
    let startX = 0;
    let startY = 0;
    let pressTimer = 0;
    const TOUCH_ROW_PX = 16; // swipe distance per arrow step in alt-screen
    const clearPressTimer = () => {
      if (pressTimer) {
        window.clearTimeout(pressTimer);
        pressTimer = 0;
      }
    };
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      touchActive = true;
      const t0 = ev.touches[0];
      lastTouchY = startY = t0.clientY;
      startX = t0.clientX;
      touchAccum = 0;
      clearPressTimer();
      // Long-press (held still) opens copy-mode — the natural gesture, no need to
      // dig into the ⋯ panel. Cancelled below if the finger moves (= a swipe).
      pressTimer = window.setTimeout(() => {
        setCopyText(bufferToText(term));
        setCopyMode(true);
      }, 450);
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (!touchActive || ev.touches.length !== 1) return;
      const tt = ev.touches[0];
      if (
        pressTimer &&
        (Math.abs(tt.clientX - startX) > 10 || Math.abs(tt.clientY - startY) > 10)
      ) {
        clearPressTimer(); // moved → it's a swipe, not a long-press
      }
      // Main buffer scrolls natively (xterm). Only alt-screen needs our arrows.
      if (term.buffer.active.type !== "alternate") return;
      const dy = lastTouchY - ev.touches[0].clientY;
      lastTouchY = ev.touches[0].clientY;
      touchAccum += dy;
      const app = (term.modes as { applicationCursorKeysMode?: boolean })
        ?.applicationCursorKeysMode;
      const up = app ? "\x1bOA" : "\x1b[A";
      const down = app ? "\x1bOB" : "\x1b[B";
      let moved = false;
      while (touchAccum >= TOUCH_ROW_PX) {
        touchAccum -= TOUCH_ROW_PX;
        moved = true;
        sshSend(sessionId, new TextEncoder().encode(down)).catch(() => {});
      }
      while (touchAccum <= -TOUCH_ROW_PX) {
        touchAccum += TOUCH_ROW_PX;
        moved = true;
        sshSend(sessionId, new TextEncoder().encode(up)).catch(() => {});
      }
      if (moved) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    const onTouchEnd = () => {
      touchActive = false;
      clearPressTimer();
    };
    const onTouchCancel = onTouchEnd;
    containerRef.current.addEventListener("touchstart", onTouchStart, {
      passive: true,
      capture: true,
    });
    containerRef.current.addEventListener("touchmove", onTouchMove, {
      passive: false,
      capture: true,
    });
    containerRef.current.addEventListener("touchend", onTouchEnd, {
      passive: true,
      capture: true,
    });
    containerRef.current.addEventListener("touchcancel", onTouchCancel, {
      passive: true,
      capture: true,
    });

    // PuTTY-style mouse — when enabled in Settings: selection auto-copies
    // (keeping the visual selection), right-click pastes from clipboard
    // immediately. Shift+right-click still opens the regular context menu.
    //
    // We capture the selection AS IT CHANGES instead of reading it back in a
    // deferred mouseup timer. A TUI that redraws (htop/tmux/Claude Code) clears
    // xterm's selection on its next refresh, so a 0-ms-later getSelection()
    // raced that redraw and intermittently returned "" — the copy silently
    // no-op'd and the next paste yielded the STALE clipboard (the reported
    // "selection copies nothing, pastes the previous buffer" glitch, which hit
    // busy tabs while a quiet tab stayed fine). mousedown resets the stash so a
    // plain click (no drag) copies nothing rather than re-copying the last one.
    let dragSelection = "";
    let dragging = false;
    const selDisposable = term.onSelectionChange(() => {
      // Only stash the selection while the USER is actively drag-selecting in
      // THIS terminal. The search addon's findNext() selects the matched text
      // to highlight it, which also fires onSelectionChange — without this gate
      // that match (≈ the search query) poisons dragSelection, and a later copy
      // whose live getSelection() came back empty (raced by a TUI redraw, see
      // below) falls back to it and pastes the SEARCH TEXT instead of what was
      // selected. That's the intermittent "clipboard gets the find query" bug.
      if (!dragging) return;
      const s = term.getSelection();
      if (s) dragSelection = s;
    });
    // mousedown on OUR container = a drag-select starts in this term. Ignore the
    // SYNTHETIC mousedown we dispatch for mobile selection (isTrusted=false) so
    // it doesn't arm the PuTTY copy-on-select path.
    const mousedownHandler = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      dragging = true;
      dragSelection = "";
    };
    // mouseup on the WINDOW, not just our container: users routinely drag the
    // selection a little past the pane / main-area edge and release the button
    // THERE, so a container-scoped mouseup never fired and the copy was lost
    // (the "copying randomly stops working" report). We gate on `dragging` so
    // only the term the drag STARTED in copies; every other term's window
    // listener sees dragging=false and no-ops.
    const mouseupHandler = (e: MouseEvent) => {
      if (!e.isTrusted) return; // ignore our synthetic mobile-selection mouseup
      if (!dragging) return;
      dragging = false;
      if (!settingsRef.current.puttyMouse) return;
      // Copy ONLY what THIS drag selected, captured live in dragSelection
      // (onSelectionChange, gated on `dragging`). Do NOT fall back to
      // term.getSelection(): after a search the find-match selection lingers, so
      // a plain click (no drag) would copy IT — the "find query ends up in the
      // clipboard" bug. A plain click leaves dragSelection "" → nothing copied;
      // a real drag stashed its text (and that survives a TUI redraw clearing
      // the live selection, which is why we stash in the first place).
      const sel = dragSelection;
      if (sel) writeClipboard(sel);
    };
    containerRef.current.addEventListener("mousedown", mousedownHandler);
    window.addEventListener("mouseup", mouseupHandler);

    // Custom right-click — xterm-helper-textarea swallows native menu, and
    // the browser menu is "Writing Direction" garbage anyway. Behaviour
    // depends on settings.puttyMouse: instant paste vs Copy/Paste/Select
    // All/Clear menu.
    // Build + show the terminal context menu (Copy/Paste/Select all/Clear).
    // Shared by desktop right-click and the mobile long-press release.
    const openTermMenu = (x: number, y: number) => {
      const tr = tRef.current;
      const selection = term.getSelection();
      const items: TerminalAction[] = [
        {
          label: tr("term_menu.copy"),
          disabled: !selection,
          onClick: () => {
            if (!selection) return;
            writeClipboard(selection);
          },
        },
        {
          label: tr("term_menu.paste"),
          onClick: async () => {
            const text = await readClipboard();
            if (text) term.paste(text);
          },
        },
        { separator: true, label: "", onClick: () => {} },
        {
          label: tr("term_menu.select_all"),
          onClick: () => term.selectAll(),
        },
        {
          label: tr("term_menu.clear"),
          onClick: () => term.clear(),
          destructive: true,
        },
      ];
      onContextMenuRef.current?.(x, y, items);
    };
    const ctxHandler = (ev: MouseEvent) => {
      // Mobile: long-press is the selection gesture; the menu is shown on touch
      // release (see touch handlers), so just swallow the browser's contextmenu.
      if (isMobileRef.current) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      if (settingsRef.current.puttyMouse && !ev.shiftKey) {
        readClipboard().then((text) => text && term.paste(text));
        return;
      }
      openTermMenu(ev.clientX, ev.clientY);
    };
    containerRef.current.addEventListener("contextmenu", ctxHandler);

    // Belt-and-suspenders for the "clipboard gets the find query" bug: whenever
    // a copy fires inside the terminal AND there's a real terminal selection,
    // force the clipboard to the TERMINAL selection. The terminal is canvas, so
    // window.getSelection() over it is empty — a stray DOM selection (e.g. the
    // find box's text) would otherwise be what the browser copies. Copies that
    // originate from the find input itself are left alone.
    const copyHandler = (ev: ClipboardEvent) => {
      if (ev.target && ev.target === findInputRef.current) return;
      const sel = term.getSelection();
      if (sel) {
        ev.clipboardData?.setData("text/plain", sel);
        ev.preventDefault();
      }
    };
    containerRef.current.addEventListener("copy", copyHandler);

    // Keyboard shortcuts intercepted at the xterm level so they NEVER reach
    // the PTY: Ctrl+Shift+C (copy), Ctrl+Shift+V (paste), Ctrl+Shift+Up
    // (transcript overlay — actual toggle handled by App.tsx capture-phase
    // window listener; we just suppress xterm's default here). Ctrl+C alone
    // is reserved for SIGINT — the natural muscle memory in any terminal.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // Session already closed → Enter reconnects (PuTTY-style), nothing is
      // sent to the (dead) PTY.
      if (closedRef.current && ev.key === "Enter") {
        closedRef.current = false;
        onReconnectRef.current?.();
        return false;
      }
      // Ctrl+F → open in-terminal find. Esc closes it (when open).
      // Match on ev.code (physical key) NOT ev.key — on a non-Latin layout
      // (Russian etc.) ev.key is the Cyrillic char ("а"/"с"/"м"), so the old
      // ev.key check silently failed: Ctrl+F didn't open search AND Ctrl+Shift+C
      // didn't run our copy handler, so the copy fell through to the browser's
      // default which grabbed the DOM selection (the find box's query) instead
      // of the terminal selection — the "clipboard gets the search text" bug.
      const ctrlOnly =
        ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey;
      if (ctrlOnly && ev.code === "KeyF") {
        openFindRef.current();
        return false;
      }
      if (findOpenRef.current && ev.key === "Escape") {
        closeFindRef.current();
        return false;
      }
      const ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
      if (ctrlShift && ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) writeClipboard(sel);
        return false;
      }
      if (ctrlShift && ev.code === "KeyV") {
        readClipboard().then((text) => text && term.paste(text));
        return false;
      }
      if (ctrlShift && (ev.key === "ArrowUp" || ev.key === "Up")) {
        return false;
      }
      return true;
    });

    const onDataDisposable = term.onData((data) => {
      sshSend(sessionId, new TextEncoder().encode(data)).catch(console.error);
    });
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      sshResize(sessionId, cols, rows).catch(console.error);
    });

    let unlistenData: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;
    // Attach BOTH event listeners before telling the backend it's safe to
    // emit (otherwise fast servers like Keenetic drop their prelogin banner
    // — backend buffers between ssh_connect and ssh_ready).
    let cancelled = false;
    (async () => {
      const [ud, uc] = await Promise.all([
        onSshData((ev) => {
          if (ev.session_id !== sessionId) return;
          term.write(new Uint8Array(ev.data));
        }),
        onSshClosed((ev) => {
          if (ev.session_id !== sessionId) return;
          const msg = tRef.current("terminal.session_closed", { reason: ev.reason });
          term.writeln(`\r\n\x1b[33m[${msg}]\x1b[0m`);
          term.writeln(`\x1b[2m[${tRef.current("terminal.enter_reconnect")}]\x1b[0m`);
          closedRef.current = true;
          // Grab focus so the Enter-to-reconnect keypress lands on this term
          // even if focus had drifted when the session dropped. Not on mobile —
          // that would pop the keyboard on every disconnect.
          if (!isMobileRef.current) term.focus();
          onSessionClosed?.(ev.reason);
        }),
      ]);
      if (cancelled) {
        ud();
        uc();
        return;
      }
      unlistenData = ud;
      unlistenClosed = uc;
      try {
        await sshReady(sessionId);
      } catch (e) {
        console.error("ssh_ready failed:", e);
      }
    })();

    const onWinResize = () => fitIfVisible(containerRef.current, fit);
    window.addEventListener("resize", onWinResize);
    sshResize(sessionId, term.cols, term.rows).catch(console.error);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onWinResize);
      containerRef.current?.removeEventListener("wheel", wheelHandler, true as any);
      containerRef.current?.removeEventListener("mousedown", mousedownHandler);
      containerRef.current?.removeEventListener("copy", copyHandler);
      containerRef.current?.removeEventListener("touchstart", onTouchStart, true);
      containerRef.current?.removeEventListener("touchmove", onTouchMove, true);
      containerRef.current?.removeEventListener("touchend", onTouchEnd, true);
      containerRef.current?.removeEventListener("touchcancel", onTouchCancel, true);
      window.removeEventListener("mouseup", mouseupHandler);
      selDisposable.dispose();
      searchResultsDisposable.dispose();
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      unlistenData?.();
      unlistenClosed?.();
      sshDisconnect(sessionId).catch(() => {});
      term.dispose();
    };
    // sessionId never changes per mount — TerminalView is keyed by it in parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit when tab becomes visible (window dimensions might have changed
  // while we were hidden). Double rAF so the display:none→block flip and the
  // flex layout settle before we measure — a single frame can still read a
  // transitional (too-narrow) box.
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitIfVisible(containerRef.current, fitRef.current);
        // Desktop: focus on tab-visible so typing just works. Mobile: don't —
        // it would pop the soft keyboard every time you switch tabs.
        if (!isMobileRef.current) termRef.current?.focus();
      });
    });
  }, [visible]);

  // Re-fit on container ResizeObserver — covers sidebar collapse, split-view
  // pane resize, and any other layout change that resizes our slot without
  // firing window resize.
  //
  // DOUBLE rAF (same as the tab-visible effect): a single frame after a split
  // or divider drag still measures a TRANSITIONAL box — usually the larger,
  // pre-shrink height — so fit() computed too many rows and pushed an oversized
  // PTY size to the remote. tmux/Claude Code then drew rows below the pane,
  // which the lower split clipped (the reported "text runs off the bottom of
  // the top split" glitch). Waiting one more frame lets the new pane height
  // settle so fit() measures the REAL visible size.
  useEffect(() => {
    if (!containerRef.current || !fitRef.current) return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          fitIfVisible(containerRef.current, fitRef.current),
        ),
      );
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Apply theme changes live to the running xterm instance.
  //
  // Both v0.0.5 (refresh only) and v0.0.6 (clearTextureAtlas + refresh) failed
  // to repaint — user lost the active session every time they flipped themes.
  // The reliable trick: temporarily resize by ±1 row to force xterm to
  // rebuild its grid layout (full repaint), then resize back. This bypasses
  // whatever stale texture/buffer state was keeping the old palette alive.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const palette = THEMES[settings.theme];
    term.options.theme = xtermThemeOf(palette);
    type WithClear = { clearTextureAtlas?: () => void };
    (term as unknown as WithClear).clearTextureAtlas?.();
    const cols = term.cols;
    const rows = term.rows;
    term.resize(cols, Math.max(1, rows - 1));
    term.resize(cols, rows);
    term.refresh(0, term.rows - 1);
  }, [settings.theme]);

  // Apply font family/size changes live.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontStackOf(settings.font);
    term.options.fontSize = settings.fontSize;
    type WithClear = { clearTextureAtlas?: () => void };
    (term as unknown as WithClear).clearTextureAtlas?.();
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      term.refresh(0, term.rows - 1);
    });
  }, [settings.font, settings.fontSize]);

  // 🔍 button in the header dispatches nx:find with the active session id.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ sessionId?: string }>;
      if (ce.detail?.sessionId === sessionId) openFindRef.current();
    };
    window.addEventListener("nx:find", handler);
    return () => window.removeEventListener("nx:find", handler);
  }, [sessionId]);

  // Mobile copy-mode: the SmartKeyBar ⧉ button fires nx:copymode; the VISIBLE
  // terminal snapshots its buffer text into a selectable overlay.
  useEffect(() => {
    const handler = () => {
      if (!visibleRef.current) return;
      const term = termRef.current;
      if (!term) return;
      setCopyText(bufferToText(term));
      setCopyMode(true);
    };
    window.addEventListener("nx:copymode", handler);
    return () => window.removeEventListener("nx:copymode", handler);
  }, []);

  // Show the latest output (what was on screen) when copy-mode opens.
  useEffect(() => {
    if (!copyMode) return;
    const el = copyPreRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [copyMode]);

  return (
    <div
      className="relative w-full h-full"
      style={{ display: visible ? "block" : "none", minHeight: 0 }}
    >
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ background: THEMES[settings.theme].bgBase, minHeight: 0 }}
      />
      {/* Mobile copy-mode overlay — plain selectable text of the buffer. Native
       *  selection (with handles) + the system copy toolbar work here because
       *  it's ordinary HTML text, not the xterm canvas/viewport. */}
      {copyMode && (
        <div
          className="absolute inset-0 z-30 flex flex-col"
          style={{ background: THEMES[settings.theme].bgBase }}
        >
          <div className="flex items-center gap-2 px-3 h-11 border-b border-nx-border shrink-0">
            <span className="flex-1 font-mono text-meta text-nx-muted truncate">
              {t("terminal.copy_mode_hint")}
            </span>
            <button
              type="button"
              onClick={() => setCopyMode(false)}
              className="font-mono text-sm px-4 py-1.5 rounded border border-nx-accent text-nx-accent active:bg-nx-elevated"
            >
              {t("terminal.copy_mode_done")}
            </button>
          </div>
          <pre
            ref={copyPreRef}
            className="nx-copy-pre flex-1 overflow-auto m-0 px-3 py-2 font-mono whitespace-pre text-nx-text"
            style={{
              fontSize: settings.fontSize,
              fontFamily: fontStackOf(settings.font),
            }}
          >
            {copyText}
          </pre>
        </div>
      )}
      {findOpen && (
        <div
          className="absolute top-1.5 right-3 z-20 flex items-center gap-1 px-1.5 py-1 bg-nx-panel border border-nx-border rounded-nx shadow-elev-modal font-mono"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Search size={12} className="text-nx-muted shrink-0" />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => {
              const q = e.target.value;
              setFindQuery(q);
              const a = searchAddonRef.current;
              if (a && q) a.findNext(q, searchOptsRef.current);
              else if (a) {
                a.clearDecorations?.();
                setFindInfo({ idx: -1, count: 0 });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runFind(!e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
            placeholder={t("terminal.find_placeholder")}
            className="w-44 bg-transparent text-meta text-nx-text placeholder:text-nx-muted outline-none"
          />
          <span className="shrink-0 text-micro tabular-nums text-nx-muted min-w-[2.5rem] text-right">
            {findInfo.count > 0
              ? `${findInfo.idx + 1}/${findInfo.count}`
              : findQuery
                ? "0/0"
                : ""}
          </span>
          <button
            onClick={() => runFind(false)}
            className="shrink-0 text-nx-muted hover:text-nx-text px-0.5"
            title={t("history.panel.find_prev")}
          >
            ‹
          </button>
          <button
            onClick={() => runFind(true)}
            className="shrink-0 text-nx-muted hover:text-nx-text px-0.5"
            title={t("history.panel.find_next")}
          >
            ›
          </button>
          <button
            onClick={closeFind}
            className="shrink-0 text-nx-muted hover:text-nx-error"
            title={t("history.panel.clear_search")}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
