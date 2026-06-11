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
      const s = term.getSelection();
      if (s) dragSelection = s;
    });
    // mousedown on OUR container = a drag-select starts in this term.
    const mousedownHandler = () => {
      dragging = true;
      dragSelection = "";
    };
    // mouseup on the WINDOW, not just our container: users routinely drag the
    // selection a little past the pane / main-area edge and release the button
    // THERE, so a container-scoped mouseup never fired and the copy was lost
    // (the "copying randomly stops working" report). We gate on `dragging` so
    // only the term the drag STARTED in copies; every other term's window
    // listener sees dragging=false and no-ops.
    const mouseupHandler = () => {
      if (!dragging) return;
      dragging = false;
      if (!settingsRef.current.puttyMouse) return;
      const sel = term.getSelection() || dragSelection;
      if (sel) writeClipboard(sel);
    };
    containerRef.current.addEventListener("mousedown", mousedownHandler);
    window.addEventListener("mouseup", mouseupHandler);

    // Custom right-click — xterm-helper-textarea swallows native menu, and
    // the browser menu is "Writing Direction" garbage anyway. Behaviour
    // depends on settings.puttyMouse: instant paste vs Copy/Paste/Select
    // All/Clear menu.
    const ctxHandler = (ev: MouseEvent) => {
      ev.preventDefault();
      if (settingsRef.current.puttyMouse && !ev.shiftKey) {
        readClipboard().then((text) => text && term.paste(text));
        return;
      }
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
      onContextMenuRef.current?.(ev.clientX, ev.clientY, items);
    };
    containerRef.current.addEventListener("contextmenu", ctxHandler);

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
      const ctrlOnly =
        ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey;
      if (ctrlOnly && ev.key.toLowerCase() === "f") {
        openFindRef.current();
        return false;
      }
      if (findOpenRef.current && ev.key === "Escape") {
        closeFindRef.current();
        return false;
      }
      const ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
      if (ctrlShift && ev.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) writeClipboard(sel);
        return false;
      }
      if (ctrlShift && ev.key.toLowerCase() === "v") {
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
