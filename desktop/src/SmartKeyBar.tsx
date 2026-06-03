// Smart key bar — the strip above the on-screen keyboard giving access to keys
// Android's soft keyboard doesn't surface. Layout (variant A, after competitor
// research — Termius/Termux/ConnectBot):
//
//   Primary row:  Esc Tab Ctrl Alt | ← ↑ ↓ → | ⌃C | Fn | ⋯
//   Fn toggles the row into F1–F12 (e.g. F10 to quit htop).
//   ⋯ expands a compact grid above the bar with the long tail: Home/End,
//   PgUp/PgDn, Ins/Del, ⌃D ⌃Z ⌃L, symbols, and paste-from-clipboard.
//
// Ctrl/Alt are STICKY modifiers: tap to arm, the next key includes them, then
// they auto-disarm. Output goes through `onSend` (active terminal send-bytes).

import { useState } from "react";

interface Props {
  onSend: (bytes: string) => void;
  /** When no active terminal, hide. */
  visible: boolean;
}

type Mod = "ctrl" | "alt";

const ESC = "\x1b";
const ARROWS = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D" };

// xterm function-key sequences. F10 = ESC[21~ — the one that quits htop.
const FKEYS: [string, string][] = [
  ["F1", "\x1bOP"], ["F2", "\x1bOQ"], ["F3", "\x1bOR"], ["F4", "\x1bOS"],
  ["F5", "\x1b[15~"], ["F6", "\x1b[17~"], ["F7", "\x1b[18~"], ["F8", "\x1b[19~"],
  ["F9", "\x1b[20~"], ["F10", "\x1b[21~"], ["F11", "\x1b[23~"], ["F12", "\x1b[24~"],
];

export function SmartKeyBar({ onSend, visible }: Props) {
  const [mods, setMods] = useState<Set<Mod>>(new Set());
  const [fnMode, setFnMode] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);

  if (!visible) return null;

  function toggleMod(m: Mod) {
    setMods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }

  // Ctrl on an ASCII letter → control code; Alt → xterm ESC prefix.
  function emit(literal: string) {
    let out = literal;
    if (mods.has("ctrl") && /^[a-zA-Z]$/.test(literal)) {
      out = String.fromCharCode(literal.toLowerCase().charCodeAt(0) - 96);
    }
    if (mods.has("alt")) out = ESC + out;
    onSend(out);
    if (mods.size > 0) setMods(new Set());
  }

  // Raw escape sequences (arrows, F-keys, nav): no Ctrl translation, Alt still
  // prefixes if armed.
  function emitRaw(seq: string) {
    onSend(mods.has("alt") ? ESC + seq : seq);
    if (mods.size > 0) setMods(new Set());
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onSend(text);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const ctrlArmed = mods.has("ctrl");
  const altArmed = mods.has("alt");

  const base =
    "shrink-0 min-w-[34px] px-2.5 py-1.5 text-[13px] font-mono rounded-nx bg-nx-panel border border-nx-border text-nx-text active:bg-nx-bg-2 active:translate-y-px";
  const armed =
    "shrink-0 min-w-[34px] px-2.5 py-1.5 text-[13px] font-mono rounded-nx bg-[var(--nx-accent)]/15 border border-nx-accent text-nx-accent";
  const sep = <span className="shrink-0 mx-1 w-px h-5 bg-nx-border" />;

  return (
    <>
      {/* Expandable grid (the "⋯" tail) — sits above the key row. */}
      {gridOpen && (
        <div className="shrink-0 grid grid-cols-4 gap-1.5 px-2 py-2 bg-nx-bg-2 border-t border-nx-border">
          <button className={base} onClick={() => emitRaw("\x1b[H")}>Home</button>
          <button className={base} onClick={() => emitRaw("\x1b[F")}>End</button>
          <button className={base} onClick={() => emitRaw("\x1b[5~")}>PgUp</button>
          <button className={base} onClick={() => emitRaw("\x1b[6~")}>PgDn</button>
          <button className={base} onClick={() => emitRaw("\x1b[2~")}>Ins</button>
          <button className={base} onClick={() => emitRaw("\x1b[3~")}>Del</button>
          <button className={base} onClick={() => onSend("\x04")}>⌃D</button>
          <button className={base} onClick={() => onSend("\x1a")}>⌃Z</button>
          <button className={base} onClick={() => emit("|")}>|</button>
          <button className={base} onClick={() => emit("~")}>~</button>
          <button className={base} onClick={() => emit("/")}>/</button>
          <button className={base} onClick={() => emit("-")}>-</button>
          <button className={base} onClick={() => onSend("\x0c")}>⌃L</button>
          <button className={base + " col-span-3"} onClick={paste}>📋 вставить</button>
        </div>
      )}

      {/* Key row */}
      <div
        className="shrink-0 h-10 flex items-center gap-1.5 px-2 overflow-x-auto bg-nx-bg-2 border-t border-nx-border select-none"
        style={{ touchAction: "pan-x" }}
      >
        {fnMode ? (
          <>
            <button
              className={armed}
              onClick={() => setFnMode(false)}
              title="Back to letters"
            >
              abc
            </button>
            {sep}
            {FKEYS.map(([label, seq]) => (
              <button key={label} className={base} onClick={() => emitRaw(seq)}>
                {label}
              </button>
            ))}
          </>
        ) : (
          <>
            <button className={base} onClick={() => emitRaw(ESC)}>Esc</button>
            <button className={base} onClick={() => emitRaw("\t")}>Tab</button>
            <button className={ctrlArmed ? armed : base} onClick={() => toggleMod("ctrl")}>Ctrl</button>
            <button className={altArmed ? armed : base} onClick={() => toggleMod("alt")}>Alt</button>
            {sep}
            <button className={base} onClick={() => emitRaw(ARROWS.left)}>←</button>
            <button className={base} onClick={() => emitRaw(ARROWS.up)}>↑</button>
            <button className={base} onClick={() => emitRaw(ARROWS.down)}>↓</button>
            <button className={base} onClick={() => emitRaw(ARROWS.right)}>→</button>
            <button className={base} onClick={() => onSend("\r")} title="Enter">↵</button>
            {sep}
            <button className={base} onClick={() => onSend("\x03")} title="Ctrl+C">⌃C</button>
            <button
              className={fnMode ? armed : base}
              onClick={() => setFnMode(true)}
              title="Function keys"
            >
              Fn
            </button>
            <button
              className={gridOpen ? armed : base}
              onClick={() => setGridOpen((v) => !v)}
              title="More keys"
            >
              ⋯
            </button>
          </>
        )}
      </div>
    </>
  );
}
