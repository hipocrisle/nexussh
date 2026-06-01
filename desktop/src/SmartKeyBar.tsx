// Smart key bar — fixed strip above the on-screen keyboard giving access to
// the keys Android's soft kbd doesn't surface: Esc, Tab, Ctrl, Alt, arrows,
// pipe/tilde/slash, plus Ctrl+C / Ctrl+D combos.
//
// Ctrl/Alt are STICKY modifiers: tap to arm, next key includes them, then
// they auto-disarm. Visual state on the chip shows armed.
//
// Output goes through `onSend` — the active terminal's send-bytes callback.

import { useState } from "react";

interface Props {
  onSend: (bytes: string) => void;
  /** When no active terminal, hide. */
  visible: boolean;
}

type Mod = "ctrl" | "alt";

const ARROW_UP = "[A";
const ARROW_DOWN = "[B";
const ARROW_RIGHT = "[C";
const ARROW_LEFT = "[D";

export function SmartKeyBar({ onSend, visible }: Props) {
  const [mods, setMods] = useState<Set<Mod>>(new Set());

  if (!visible) return null;

  function toggleMod(m: Mod) {
    setMods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }

  function clearMods() {
    setMods(new Set());
  }

  // Apply armed Ctrl by lower-case-ASCII-AND-0x1f (terminal convention).
  // Alt is xterm-style ESC prefix.
  function emit(literal: string) {
    let out = literal;
    if (mods.has("ctrl") && /^[a-zA-Z]$/.test(literal)) {
      const code = literal.toLowerCase().charCodeAt(0) - 96; // a→1 ... z→26
      out = String.fromCharCode(code);
    }
    if (mods.has("alt")) out = "" + out;
    onSend(out);
    if (mods.size > 0) clearMods();
  }

  function emitRaw(seq: string) {
    // Special sequences: don't re-apply Ctrl/Alt translation.
    if (mods.has("alt")) onSend("" + seq);
    else onSend(seq);
    if (mods.size > 0) clearMods();
  }

  const ctrlArmed = mods.has("ctrl");
  const altArmed = mods.has("alt");

  const baseBtn =
    "shrink-0 px-2.5 py-1.5 text-[13px] font-mono rounded-nx bg-nx-panel border border-nx-border text-nx-text active:bg-nx-bg-2 active:translate-y-px";
  const armedBtn =
    "shrink-0 px-2.5 py-1.5 text-[13px] font-mono rounded-nx bg-[var(--nx-accent)]/15 border border-nx-accent text-nx-accent";

  return (
    <div
      className="shrink-0 h-10 flex items-center gap-1.5 px-2 overflow-x-auto bg-nx-bg-2 border-t border-nx-border select-none"
      style={{ touchAction: "pan-x" }}
    >
      <button className={baseBtn} onClick={() => emitRaw("")}>
        Esc
      </button>
      <button className={baseBtn} onClick={() => emitRaw("\t")}>
        Tab
      </button>
      <button
        className={ctrlArmed ? armedBtn : baseBtn}
        onClick={() => toggleMod("ctrl")}
      >
        Ctrl
      </button>
      <button
        className={altArmed ? armedBtn : baseBtn}
        onClick={() => toggleMod("alt")}
      >
        Alt
      </button>
      <span className="shrink-0 mx-1 w-px h-5 bg-nx-border" />
      <button className={baseBtn} onClick={() => emitRaw(ARROW_UP)}>
        ↑
      </button>
      <button className={baseBtn} onClick={() => emitRaw(ARROW_DOWN)}>
        ↓
      </button>
      <button className={baseBtn} onClick={() => emitRaw(ARROW_LEFT)}>
        ←
      </button>
      <button className={baseBtn} onClick={() => emitRaw(ARROW_RIGHT)}>
        →
      </button>
      <span className="shrink-0 mx-1 w-px h-5 bg-nx-border" />
      <button className={baseBtn} onClick={() => emit("|")}>
        |
      </button>
      <button className={baseBtn} onClick={() => emit("~")}>
        ~
      </button>
      <button className={baseBtn} onClick={() => emit("/")}>
        /
      </button>
      <button className={baseBtn} onClick={() => emit("-")}>
        -
      </button>
      <span className="shrink-0 mx-1 w-px h-5 bg-nx-border" />
      <button
        className={baseBtn}
        onClick={() => onSend(String.fromCharCode(3))}
        title="Ctrl+C"
      >
        ⌃C
      </button>
      <button
        className={baseBtn}
        onClick={() => onSend(String.fromCharCode(4))}
        title="Ctrl+D"
      >
        ⌃D
      </button>
      <button
        className={baseBtn}
        onClick={() => onSend(String.fromCharCode(26))}
        title="Ctrl+Z"
      >
        ⌃Z
      </button>
      <button
        className={baseBtn}
        onClick={() => onSend(String.fromCharCode(12))}
        title="Ctrl+L (clear)"
      >
        ⌃L
      </button>
    </div>
  );
}
