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

interface Props {
  sessionId: string;
  visible: boolean;
  /** Called when the SSH session ends (remote close / disconnect / error). */
  onSessionClosed?: (reason: string) => void;
}

const MATRIX_THEME = {
  background: "#0a0e0e",
  foreground: "#c9d1d9",
  cursor: "#00ff95",
  cursorAccent: "#0a0e0e",
  selectionBackground: "#1f3a3a",
  black: "#0a0e0e",
  red: "#ff6b6b",
  green: "#00ff95",
  yellow: "#f5d76e",
  blue: "#5cc8ff",
  magenta: "#d391ff",
  cyan: "#00d4ff",
  white: "#c9d1d9",
  brightBlack: "#4a5560",
  brightRed: "#ff8e8e",
  brightGreen: "#5fffb4",
  brightYellow: "#ffe28a",
  brightBlue: "#7fd7ff",
  brightMagenta: "#e1b3ff",
  brightCyan: "#5feaff",
  brightWhite: "#ffffff",
};

export function TerminalView({
  sessionId,
  visible,
  onSessionClosed,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Keep latest t() in a ref so the mount-once effect always gets fresh translation
  const tRef = useRef(t);
  tRef.current = t;

  // Initialize terminal once per session
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: MATRIX_THEME,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
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

    // Hijack mouse wheel — always scroll the terminal buffer instead of
    // sending arrow-key escape sequences to the remote app. Default xterm.js
    // behavior translates wheel events into `\x1bOA`/`\x1bOB` when the remote
    // is in alt-screen mode (Claude Code, vim, htop, less, tmux), which is
    // disorienting for users expecting browser-like scroll.
    term.attachCustomWheelEventHandler((ev: WheelEvent) => {
      const lines = Math.max(1, Math.round(Math.abs(ev.deltaY) / 24));
      term.scrollLines(ev.deltaY > 0 ? lines : -lines);
      ev.preventDefault();
      return false;
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

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[#0a0e0e]"
      style={{
        display: visible ? "block" : "none",
        minHeight: 0,
      }}
    />
  );
}
