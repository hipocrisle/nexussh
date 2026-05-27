// Terminal component: wraps xterm.js, wires to our Tauri SSH commands.

import { useEffect, useRef } from "react";
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
  onClose?: () => void;
}

// Matrix theme — applied to xterm directly. Tailwind handles outer chrome.
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

export function TerminalView({ sessionId, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: MATRIX_THEME,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Forward keystrokes to SSH session
    const onDataDisposable = term.onData((data) => {
      sshSend(sessionId, new TextEncoder().encode(data)).catch(console.error);
    });
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      sshResize(sessionId, cols, rows).catch(console.error);
    });

    // Subscribe to backend ssh-data events
    let unlistenData: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;
    onSshData((ev) => {
      if (ev.session_id !== sessionId) return;
      term.write(new Uint8Array(ev.data));
    }).then((u) => (unlistenData = u));
    onSshClosed((ev) => {
      if (ev.session_id !== sessionId) return;
      term.writeln(`\r\n\x1b[33m[session closed: ${ev.reason}]\x1b[0m`);
      onClose?.();
    }).then((u) => (unlistenClosed = u));

    // Window resize → xterm fit
    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);

    // Initial sync: emit resize for the freshly-sized terminal
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
  }, [sessionId, onClose]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[#0a0e0e]"
      style={{ minHeight: 0 }}
    />
  );
}
