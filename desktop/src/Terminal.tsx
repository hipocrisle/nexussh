// Terminal component: wraps xterm.js, wires to our Tauri SSH commands.
// One instance per session — kept mounted while the tab exists; visibility
// is toggled by parent via CSS so xterm state persists across tab switches.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  sshSend,
  sshResize,
  sshDisconnect,
  onSshData,
  onSshClosed,
} from "./ssh";
import { useSettings } from "./settings/settings-store";
import { THEMES, xtermThemeOf } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";

export interface TerminalAction {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface Props {
  sessionId: string;
  visible: boolean;
  /** Called when the SSH session ends (remote close / disconnect / error). */
  onSessionClosed?: (reason: string) => void;
  /** Parent renders the context menu — we just emit position + items. */
  onContextMenu?: (x: number, y: number, items: TerminalAction[]) => void;
}

export function TerminalView({
  sessionId,
  visible,
  onSessionClosed,
  onContextMenu,
}: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Keep latest t() in a ref so the mount-once effect always gets fresh translation
  const tRef = useRef(t);
  tRef.current = t;
  // Same for onContextMenu — we want the LATEST callback when the user
  // right-clicks, but we register the listener once at mount.
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;

  // Initialize terminal once per session — uses INITIAL settings; later
  // changes are pushed via the effects below.
  useEffect(() => {
    if (!containerRef.current) return;
    const initialTheme = THEMES[settings.theme];

    const term = new Terminal({
      theme: xtermThemeOf(initialTheme),
      fontFamily: fontStackOf(settings.font),
      fontSize: settings.fontSize,
      cursorBlink: true,
      scrollback: 100_000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

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

    // Custom right-click menu — xterm-helper-textarea swallows native menu,
    // and even if it didn't, the browser menu is "Writing Direction" garbage.
    // Build a real terminal menu: Copy / Paste / Select All / Clear.
    const ctxHandler = (ev: MouseEvent) => {
      ev.preventDefault();
      const tr = tRef.current;
      const selection = term.getSelection();
      const items: TerminalAction[] = [
        {
          label: tr("term_menu.copy"),
          disabled: !selection,
          onClick: () => {
            if (!selection) return;
            navigator.clipboard.writeText(selection).catch(console.error);
          },
        },
        {
          label: tr("term_menu.paste"),
          onClick: async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) term.paste(text);
            } catch (e) {
              console.error("paste failed:", e);
            }
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
    // (transcript overlay — actual toggle is handled by the window-level
    // capture-phase listener in App.tsx; we just suppress xterm's default
    // here so it doesn't translate to ESC sequences and confuse the remote).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
      if (ctrlShift && ev.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ctrlShift && ev.key.toLowerCase() === "v") {
        navigator.clipboard
          .readText()
          .then((text) => text && term.paste(text))
          .catch(() => {});
        return false;
      }
      if (ctrlShift && (ev.key === "ArrowUp" || ev.key === "Up")) {
        return false; // window-level handler will toggle the overlay
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
    onSshData((ev) => {
      if (ev.session_id !== sessionId) return;
      term.write(new Uint8Array(ev.data));
    }).then((u) => (unlistenData = u));
    onSshClosed((ev) => {
      if (ev.session_id !== sessionId) return;
      const msg = tRef.current("terminal.session_closed", { reason: ev.reason });
      term.writeln(`\r\n\x1b[33m[${msg}]\x1b[0m`);
      onSessionClosed?.(ev.reason);
    }).then((u) => (unlistenClosed = u));

    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);
    sshResize(sessionId, term.cols, term.rows).catch(console.error);

    return () => {
      window.removeEventListener("resize", onWinResize);
      containerRef.current?.removeEventListener("wheel", wheelHandler, true as any);
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
  // while we were hidden)
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
  }, [visible]);

  // Re-fit on container ResizeObserver — covers sidebar collapse and any
  // other layout change that resizes our slot without firing window resize.
  useEffect(() => {
    if (!containerRef.current || !fitRef.current) return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => fitRef.current?.fit());
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

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{
        background: THEMES[settings.theme].bgBase,
        display: visible ? "block" : "none",
        minHeight: 0,
      }}
    />
  );
}
