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
import { readClipboard, writeClipboard, copyTextVerbose } from "./clipboard";
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
  // Mobile: show the "Copy" pill after a touch selection (set from the touch
  // handlers in the mount effect via the stable setter).
  // Mobile: brief "Скопировано" toast, shown only on an EXPLICIT copy (tap on the
  // selection). Selection itself no longer auto-copies.
  const [copiedToast, setCopiedToast] = useState(false);
  const [showLog, setShowLog] = useState(false); // mobile debug-log panel
  const copiedTimerRef = useRef<number | null>(null);
  const flashCopied = () => {
    setCopiedToast(true);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedToast(false), 1500);
  };
  // Debug log ring for diagnosing mobile selection — dumped to clipboard via the
  // 🐞 button. Cheap; only the touch handlers write to it.
  const dbgRef = useRef<string[]>([]);
  const dbg = (m: string) => {
    const a = dbgRef.current;
    a.push(m);
    if (a.length > 400) a.shift();
  };

  // ── Mobile selection drag-handles ─────────────────────────────────────────
  // Two Android-style handles at the selection ends; dragging either re-runs
  // term.select() so the user can extend a word/range to anything. All cell math
  // is INCLUSIVE here; getSelectionPosition().end is exclusive (start+len), so we
  // convert it when needed.
  const [handles, setHandles] = useState<
    { a: { x: number; y: number }; b: { x: number; y: number }; h: number } | null
  >(null);
  const handleDragRef = useRef<{ which: "a" | "b"; fixed: { col: number; row: number } } | null>(
    null,
  );
  const refreshHandlesRef = useRef<() => void>(() => {});
  const rowsGeom = () => {
    const term = termRef.current;
    const cont = containerRef.current;
    const rowsEl = cont?.querySelector(".xterm-rows") as HTMLElement | null;
    if (!term || !cont || !rowsEl) return null;
    const cRect = cont.getBoundingClientRect();
    const rRect = rowsEl.getBoundingClientRect();
    if (rRect.width <= 0 || rRect.height <= 0) return null;
    return {
      term,
      cRect,
      rRect,
      cellW: rRect.width / term.cols,
      cellH: rRect.height / term.rows,
      vy: term.buffer.active.viewportY,
    };
  };
  const cellFromClient = (x: number, y: number) => {
    const g = rowsGeom();
    if (!g) return null;
    const col = Math.min(g.term.cols - 1, Math.max(0, Math.floor((x - g.rRect.left) / g.cellW)));
    const vrow = Math.min(g.term.rows - 1, Math.max(0, Math.floor((y - g.rRect.top) / g.cellH)));
    return { col, row: g.vy + vrow };
  };
  const refreshHandles = () => {
    const term = termRef.current;
    const g = rowsGeom();
    const pos = term?.getSelectionPosition?.();
    if (!isMobile || !term || !g || !pos || !term.hasSelection()) {
      setHandles(null);
      return;
    }
    setHandles({
      a: {
        x: g.rRect.left - g.cRect.left + pos.start.x * g.cellW,
        y: g.rRect.top - g.cRect.top + (pos.start.y - g.vy) * g.cellH,
      },
      b: {
        x: g.rRect.left - g.cRect.left + pos.end.x * g.cellW,
        y: g.rRect.top - g.cRect.top + (pos.end.y - g.vy) * g.cellH,
      },
      h: g.cellH,
    });
  };
  refreshHandlesRef.current = refreshHandles;
  const onHandleStart = (which: "a" | "b") => (e: React.TouchEvent) => {
    const term = termRef.current;
    const pos = term?.getSelectionPosition?.();
    if (!term || !pos) return;
    // Fix the OPPOSITE endpoint (inclusive cells); end is exclusive → -1.
    const fixed =
      which === "b"
        ? { col: pos.start.x, row: pos.start.y }
        : pos.end.x > 0
          ? { col: pos.end.x - 1, row: pos.end.y }
          : { col: term.cols - 1, row: pos.end.y - 1 };
    handleDragRef.current = { which, fixed };
    e.stopPropagation();
  };
  const onHandleMove = (e: React.TouchEvent) => {
    const d = handleDragRef.current;
    const term = termRef.current;
    if (!d || !term) return;
    const t = e.touches[0];
    const focus = cellFromClient(t.clientX, t.clientY);
    if (focus) {
      let lo = d.fixed;
      let hi = focus;
      if (hi.row < lo.row || (hi.row === lo.row && hi.col < lo.col)) {
        lo = focus;
        hi = d.fixed;
      }
      const len = (hi.row - lo.row) * term.cols + (hi.col - lo.col) + 1;
      if (len > 0) {
        term.select(lo.col, lo.row, len);
        term.refresh(0, term.rows - 1);
      }
    }
    e.stopPropagation();
  };
  const onHandleEnd = (e: React.TouchEvent) => {
    // Dragging a handle only adjusts the range now — copy happens when the user
    // taps the selection.
    handleDragRef.current = null;
    e.stopPropagation();
  };

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
    // OUR OWN selection, the same way desktop selects: drive xterm's term.select()
    // (the exact selection layer the desktop uses) from touch. Long-press starts
    // it, drag extends it, release shows a "Copy" pill. A plain swipe scrolls
    // (xterm handles main-buffer scroll itself; alt-screen → arrows). No native
    // browser selection, no library patches — fully our code.
    let touchActive = false;
    let lastTouchY = 0;
    let startX = 0;
    let startY = 0;
    let scrolling = false;
    let selecting = false;
    let pressTimer = 0;
    let touchAccum = 0;
    let selAnchor: { col: number; row: number } | null = null;
    let tapSelText = ""; // selection text captured at touchstart, if tap is on it
    const TOUCH_ROW_PX = 16; // swipe distance per arrow step in alt-screen
    // Is a cell inside the current selection? (start inclusive, end exclusive.)
    const cellInSelection = (c: { col: number; row: number }) => {
      const pos = term.getSelectionPosition();
      if (!pos || !term.hasSelection()) return false;
      const afterStart =
        c.row > pos.start.y || (c.row === pos.start.y && c.col >= pos.start.x);
      const beforeEnd =
        c.row < pos.end.y || (c.row === pos.end.y && c.col < pos.end.x);
      return afterStart && beforeEnd;
    };
    // Map a touch point to a terminal cell using the REAL rendered rows box
    // (width/cols, height/rows) — robust, no internal xterm APIs.
    const cellFromTouch = (
      x: number,
      y: number,
      tag: string,
    ): { col: number; row: number } | null => {
      const rowsEl = containerRef.current?.querySelector(".xterm-rows") as HTMLElement | null;
      const scrEl = containerRef.current?.querySelector(".xterm-screen") as HTMLElement | null;
      const el = rowsEl ?? scrEl;
      if (!el) {
        dbg(`cell[${tag}] NO-ELEM rows=${!!rowsEl} scr=${!!scrEl}`);
        return null;
      }
      const rect = el.getBoundingClientRect();
      const cols = term.cols || 80;
      const vrows = term.rows || 24;
      if (rect.width <= 0 || rect.height <= 0) {
        dbg(`cell[${tag}] ZERO-RECT w=${rect.width} h=${rect.height} el=${rowsEl ? "rows" : "scr"}`);
        return null;
      }
      const cellW = rect.width / cols;
      const cellH = rect.height / vrows;
      const col = Math.min(cols - 1, Math.max(0, Math.floor((x - rect.left) / cellW)));
      const visRow = Math.min(vrows - 1, Math.max(0, Math.floor((y - rect.top) / cellH)));
      const vy = term.buffer.active.viewportY;
      dbg(
        `cell[${tag}] el=${rowsEl ? "rows" : "scr"} xy=${Math.round(x)},${Math.round(y)} ` +
          `rect=${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} ` +
          `cols=${cols} vrows=${vrows} cw=${cellW.toFixed(1)} ch=${cellH.toFixed(1)} -> col=${col} vrow=${visRow} row=${vy + visRow}`,
      );
      return { col, row: vy + visRow };
    };
    const applySelection = (
      a: { col: number; row: number },
      b: { col: number; row: number },
    ) => {
      let s = a;
      let e = b;
      if (b.row < a.row || (b.row === a.row && b.col < a.col)) { s = b; e = a; }
      const len = (e.row - s.row) * term.cols + (e.col - s.col) + 1;
      if (len > 0) {
        term.select(s.col, s.row, len);
        // term.select() updates the model but the DOM renderer doesn't always
        // repaint the highlight when the change came from the API (vs a mouse
        // drag). Force a repaint so the selection is actually visible on touch.
        term.refresh(0, term.rows - 1);
      }
    };
    const clearPress = () => {
      if (pressTimer) { window.clearTimeout(pressTimer); pressTimer = 0; }
    };
    // Word boundaries (non-space run) around a cell — for long-press word-select.
    const wordRangeAt = (c: { col: number; row: number }) => {
      const line = term.buffer.active.getLine(c.row);
      if (!line) return null;
      const text = line.translateToString(true);
      const ch = text[c.col];
      if (c.col >= text.length || !ch || /\s/.test(ch)) return null;
      let s = c.col;
      let e = c.col;
      while (s > 0 && !/\s/.test(text[s - 1])) s--;
      while (e < text.length - 1 && !/\s/.test(text[e + 1])) e++;
      return { col: s, row: c.row, len: e - s + 1 };
    };
    const onTouchStart = (ev: TouchEvent) => {
      dbg(`START touches=${ev.touches.length}`);
      if (ev.touches.length !== 1) return;
      touchActive = true;
      const t0 = ev.touches[0];
      startX = t0.clientX;
      startY = lastTouchY = t0.clientY;
      scrolling = false;
      selecting = false;
      selAnchor = null;
      touchAccum = 0;
      // Capture the selection (if the press lands ON it) BEFORE xterm's own
      // mousedown can clear it — a quick tap here then means "copy".
      tapSelText = "";
      if (term.hasSelection()) {
        const c0 = cellFromTouch(startX, startY, "tap?");
        if (c0 && cellInSelection(c0)) tapSelText = term.getSelection();
      }
      dbg(`START xy=${Math.round(startX)},${Math.round(startY)} buf=${term.buffer.active.type} onSel=${!!tapSelText}`);
      clearPress();
      pressTimer = window.setTimeout(() => {
        // Held still → select the WORD under the finger (like every mobile app).
        // Dragging on without lifting then extends from the word; or lift and use
        // the handles to adjust the range.
        dbg(`LONGPRESS fire (timer)`);
        selecting = true;
        const c = cellFromTouch(startX, startY, "press");
        if (c) {
          term.clearSelection();
          const w = wordRangeAt(c);
          if (w) {
            term.select(w.col, w.row, w.len);
            selAnchor = { col: w.col, row: w.row };
            dbg(`LONGPRESS word col=${w.col} row=${w.row} len=${w.len}`);
          } else {
            applySelection(c, c);
            selAnchor = c;
            dbg(`LONGPRESS char col=${c.col} row=${c.row}`);
          }
          term.refresh(0, term.rows - 1);
        } else {
          dbg(`LONGPRESS cellFromTouch failed`);
        }
        try { navigator.vibrate?.(12); } catch { /* ignore */ }
      }, 380);
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (!touchActive || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      if (selecting) {
        const end = cellFromTouch(t.clientX, t.clientY, "move");
        if (end && selAnchor) applySelection(selAnchor, end);
        dbg(`MOVE(sel) end=${end ? end.col + "," + end.row : "NULL"} selLen=${term.getSelection().length}`);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      // Micro-jitter while still → could be a forming long-press; wait.
      if (
        !scrolling &&
        Math.abs(t.clientX - startX) <= 10 &&
        Math.abs(t.clientY - startY) <= 10
      ) {
        return;
      }
      // Real movement → it's a swipe; abandon the pending long-press.
      if (!scrolling) dbg(`SWIPE begin dx=${Math.round(t.clientX - startX)} dy=${Math.round(t.clientY - startY)} buf=${term.buffer.active.type}`);
      scrolling = true;
      clearPress();
      const y = t.clientY;
      const dy = lastTouchY - y; // finger up → dy>0 → scroll content downward
      lastTouchY = y;
      // Alt-screen: swipe → arrows. Main buffer: let xterm scroll natively (we
      // don't touch it — no preventDefault, so xterm's own touch-scroll runs).
      if (term.buffer.active.type === "alternate") {
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
      }
    };
    const onTouchEnd = () => {
      touchActive = false;
      clearPress();
      const wasSelecting = selecting;
      selecting = false;
      dbg(`END selecting=${wasSelecting} scrolling=${scrolling} tap=${!!tapSelText} selLen=${term.getSelection().length}`);
      // A quick tap (no long-press, no scroll) ON the existing selection = COPY.
      // Must run synchronously here to keep the user-gesture for execCommand.
      if (!wasSelecting && !scrolling && tapSelText) {
        copyTextVerbose(tapSelText)
          .then((r) => dbg(`COPY(tap) ${r}`))
          .catch((e) => dbg(`COPY(tap) EXC ${String(e).slice(0, 80)}`));
        flashCopied();
        term.clearSelection(); // copied → dismiss selection + handles
      } else if (!wasSelecting && !scrolling && term.hasSelection()) {
        // Tap OUTSIDE the selection → deselect.
        term.clearSelection();
      }
    };
    const onTouchCancel = () => {
      touchActive = false;
      clearPress();
      selecting = false;
    };
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
    // Any selection change on mobile (double-tap word, long-press, handle drag)
    // → (re)position the drag handles. Copy is an explicit tap on the selection.
    const selDispose = term.onSelectionChange(() => {
      if (!isMobileRef.current) return;
      refreshHandlesRef.current();
    });
    // Keep handles glued to the selection as the screen scrolls/redraws.
    const renderDispose = term.onRender(() => {
      if (isMobileRef.current && term.hasSelection()) refreshHandlesRef.current();
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

    // Android IME doubling — DIAGNOSTIC build. The capture-phase input
    // suppression (beta.35) broke xterm's textarea cleanup (→ "pastes already
    // typed text"), so it's removed. Here we only OBSERVE the input pipeline
    // (composition + input + onData, with timing) so one typing log pins down the
    // exact duplicate mechanism, plus a conservative exact-dup drop after a
    // compositionend. The passive listeners never block anything.
    let lastCompositionEndAt = -1e9;
    const esc = (s: string) =>
      s.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\x1b/g, "\\e");
    if (isMobileRef.current) {
      const ta = containerRef.current.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (ta) {
        ta.addEventListener("compositionstart", () => dbg(`comp:start`));
        ta.addEventListener("compositionupdate", (e) =>
          dbg(`comp:update '${esc((e as CompositionEvent).data ?? "")}'`),
        );
        ta.addEventListener("compositionend", (e) => {
          lastCompositionEndAt = performance.now();
          dbg(`comp:end '${esc((e as CompositionEvent).data ?? "")}'`);
        });
        ta.addEventListener("input", (e) => {
          const ie = e as InputEvent;
          const dt = (performance.now() - lastCompositionEndAt).toFixed(0);
          dbg(
            `input type=${ie.inputType} comp=${ie.isComposing} dt=${dt} '${esc(ie.data ?? "")}'`,
          );
        });
      }
    }
    let lastData = "";
    let lastDataAt = -1e9;
    const onDataDisposable = term.onData((data) => {
      const now = performance.now();
      const sinceComp = now - lastCompositionEndAt;
      dbg(`onData sinceComp=${sinceComp.toFixed(0)} '${esc(data).slice(0, 24)}'`);
      // Conservative: drop only an EXACT repeat of the immediately-previous data
      // when it lands right after a compositionend (the classic finalize+input
      // double). Anything else passes through untouched.
      if (sinceComp < 350 && data === lastData && now - lastDataAt < 350) {
        dbg(`  ↑ dropped (dup after comp)`);
        return;
      }
      lastData = data;
      lastDataAt = now;
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
      selDispose.dispose();
      renderDispose.dispose();
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

  // Sending input (paste / SmartKeyBar / snippets) invalidates a mobile
  // selection — drop it and its handles so they don't linger or slide.
  useEffect(() => {
    const onInput = (e: Event) => {
      const ce = e as CustomEvent<{ sessionId?: string }>;
      if (ce.detail?.sessionId !== sessionId) return;
      termRef.current?.clearSelection();
      setHandles(null);
    };
    window.addEventListener("nx:input", onInput);
    return () => window.removeEventListener("nx:input", onInput);
  }, [sessionId]);

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
      {/* Mobile: "Скопировано" toast — only on an explicit tap-to-copy. */}
      {copiedToast && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-nx bg-nx-panel border border-nx-border text-nx-text-primary font-mono text-meta shadow-elev-modal pointer-events-none">
          ✓ {t("term_menu.copied")}
        </div>
      )}
      {/* Mobile: Android-style selection drag-handles — grab & extend the range. */}
      {handles && (
        <>
          {([
            ["a", handles.a],
            ["b", handles.b],
          ] as const).map(([k, p]) => (
            <div
              key={k}
              onTouchStart={onHandleStart(k)}
              onTouchMove={onHandleMove}
              onTouchEnd={onHandleEnd}
              onTouchCancel={onHandleEnd}
              className="absolute z-30 flex items-start justify-center"
              style={{
                left: p.x - 16,
                top: p.y + handles.h - 3,
                width: 32,
                height: 32,
                touchAction: "none",
              }}
            >
              <div
                className="rounded-full shadow-elev-modal"
                style={{
                  width: 18,
                  height: 18,
                  background: palette.accent,
                  border: `2px solid ${palette.bgBase}`,
                }}
              />
            </div>
          ))}
        </>
      )}
      {/* Mobile: debug-log button — opens an on-screen panel that's easy to
          SCREENSHOT (and copy) for diagnosis, instead of dumping to clipboard
          where it could land in the shell. */}
      {isMobile && (
        <button
          type="button"
          className="absolute bottom-2 right-2 z-20 w-9 h-9 rounded-full bg-nx-panel/80 border border-nx-border text-meta active:opacity-70"
          title="debug log"
          onClick={() => setShowLog(true)}
        >
          🐞
        </button>
      )}
      {showLog && (
        <div className="absolute inset-0 z-40 flex flex-col bg-nx-bg-base/95">
          <div className="flex items-center gap-2 p-2 border-b border-nx-border shrink-0">
            <span className="font-mono text-meta text-nx-text-primary">
              debug log ({dbgRef.current.length})
            </span>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded-nx bg-nx-accent text-nx-bg-base font-mono text-meta active:opacity-80"
                onClick={() =>
                  copyTextVerbose(dbgRef.current.join("\n") || "(empty)").catch(
                    () => {},
                  )
                }
              >
                ⧉ copy
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-nx bg-nx-panel border border-nx-border font-mono text-meta text-nx-text-primary active:opacity-80"
                onClick={() => {
                  dbgRef.current = [];
                  setShowLog(false);
                }}
              >
                clear
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-nx bg-nx-panel border border-nx-border font-mono text-meta text-nx-text-primary active:opacity-80"
                onClick={() => setShowLog(false)}
              >
                ✕
              </button>
            </div>
          </div>
          <pre className="flex-1 overflow-auto p-2 m-0 font-mono text-[10px] leading-tight text-nx-text-primary whitespace-pre-wrap break-all">
            {dbgRef.current.join("\n") || "(empty)"}
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
