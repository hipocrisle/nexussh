// Smart key bar — the strip above the on-screen keyboard giving access to keys
// Android's soft keyboard doesn't surface. Redesign (after Termius/Termux/
// ConnectBot research): TWO fixed rows, buttons stretch to full width so they
// are large tap targets, and — crucially — NO horizontal scroll. Horizontal
// scroll fights Android's edge-swipe gesture (swiping past the scrollbar end
// switches apps), which Termius avoids by keeping everything on one screen.
//
//   Row 1:  Esc  Ctrl  Alt  Tab  Fn  ⋯  ⌨
//   Row 2:  ⌃C   ←    ↑    ↓    →   ↵
//   Fn  → reveals F1–F12 (two rows of 6) in a panel above (e.g. F10 quits htop).
//   ⋯   → reveals the long tail (Home/End, PgUp/PgDn, Ins/Del, symbols, paste).
//   ⌨   → show/hide the soft keyboard (focus/blur the terminal).
//
// Ctrl/Alt are STICKY modifiers: tap to arm, the next key includes them, then
// they auto-disarm. Every button fires on pointer-DOWN and preventDefault()s so
// it never steals focus from the terminal textarea — that keeps the on-screen
// keyboard up while you use the bar (tapping a focus-stealing button would
// dismiss it). Output goes through `onSend` (active terminal send-bytes).

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

const KEY =
  "flex-1 min-w-0 h-11 text-[15px] leading-none font-mono rounded-nx border bg-nx-panel border-nx-border text-nx-text active:bg-nx-bg-2 active:translate-y-px flex items-center justify-center";
const KEY_ARMED =
  "flex-1 min-w-0 h-11 text-[15px] leading-none font-mono rounded-nx border bg-[var(--nx-accent)]/15 border-nx-accent text-nx-accent flex items-center justify-center";

/** A bar key. Fires on pointer-down and preventDefault()s so it never steals
 *  focus from the terminal — the soft keyboard stays up while you tap. */
function Key({
  label,
  onTap,
  armed,
  title,
}: {
  label: React.ReactNode;
  onTap: () => void;
  armed?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      className={armed ? KEY_ARMED : KEY}
      onPointerDown={(e) => {
        e.preventDefault();
        onTap();
      }}
    >
      {label}
    </button>
  );
}

export function SmartKeyBar({ onSend, visible }: Props) {
  const [mods, setMods] = useState<Set<Mod>>(new Set());
  const [panel, setPanel] = useState<null | "fn" | "more">(null);

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

  // Show/hide the soft keyboard by focusing/blurring the terminal's hidden
  // textarea. Because every key preventDefault()s, the textarea keeps focus
  // while the bar is used, so activeElement reliably tells us the current state.
  function toggleKeyboard() {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae.tagName === "TEXTAREA") {
      ae.blur();
      return;
    }
    const tas = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea"),
    );
    // The visible terminal's textarea has a non-null offsetParent (not hidden).
    (tas.find((t) => t.offsetParent !== null) ?? tas[0])?.focus();
  }

  const ctrlArmed = mods.has("ctrl");
  const altArmed = mods.has("alt");

  return (
    <div
      className="shrink-0 bg-nx-bg-2 border-t border-nx-border select-none"
      style={{ touchAction: "manipulation" }}
    >
      {/* Fn panel — F1–F12 in two rows of six. */}
      {panel === "fn" && (
        <div className="flex flex-col gap-1.5 px-2 pt-2 border-b border-nx-border">
          <div className="flex gap-1.5">
            {FKEYS.slice(0, 6).map(([label, seq]) => (
              <Key key={label} label={label} onTap={() => emitRaw(seq)} />
            ))}
          </div>
          <div className="flex gap-1.5 pb-2">
            {FKEYS.slice(6).map(([label, seq]) => (
              <Key key={label} label={label} onTap={() => emitRaw(seq)} />
            ))}
          </div>
        </div>
      )}

      {/* More panel — the long tail. */}
      {panel === "more" && (
        <div className="flex flex-col gap-1.5 px-2 pt-2 border-b border-nx-border">
          <div className="flex gap-1.5">
            <Key label="Home" onTap={() => emitRaw("\x1b[H")} />
            <Key label="End" onTap={() => emitRaw("\x1b[F")} />
            <Key label="PgUp" onTap={() => emitRaw("\x1b[5~")} />
            <Key label="PgDn" onTap={() => emitRaw("\x1b[6~")} />
            <Key label="Ins" onTap={() => emitRaw("\x1b[2~")} />
            <Key label="Del" onTap={() => emitRaw("\x1b[3~")} />
          </div>
          <div className="flex gap-1.5">
            <Key label="⌃D" onTap={() => onSend("\x04")} title="Ctrl+D" />
            <Key label="⌃Z" onTap={() => onSend("\x1a")} title="Ctrl+Z" />
            <Key label="⌃L" onTap={() => onSend("\x0c")} title="Ctrl+L (clear)" />
            <Key label="|" onTap={() => emit("|")} />
            <Key label="~" onTap={() => emit("~")} />
            <Key label="/" onTap={() => emit("/")} />
          </div>
          <div className="flex gap-1.5 pb-2">
            <Key label="-" onTap={() => emit("-")} />
            <Key label="`" onTap={() => emit("`")} />
            <Key label="*" onTap={() => emit("*")} />
            <Key label="&" onTap={() => emit("&")} />
            <Key label="$" onTap={() => emit("$")} />
            <Key label="📋" onTap={paste} title="Вставить" />
          </div>
        </div>
      )}

      {/* Row 1 — Esc, modifiers, panels, keyboard toggle. */}
      <div className="flex gap-1.5 px-2 pt-1.5">
        <Key label="Esc" onTap={() => emitRaw(ESC)} />
        <Key label="Ctrl" armed={ctrlArmed} onTap={() => toggleMod("ctrl")} />
        <Key label="Alt" armed={altArmed} onTap={() => toggleMod("alt")} />
        <Key label="Tab" onTap={() => emitRaw("\t")} />
        <Key
          label="Fn"
          armed={panel === "fn"}
          title="Функциональные клавиши"
          onTap={() => setPanel((p) => (p === "fn" ? null : "fn"))}
        />
        <Key
          label="⋯"
          armed={panel === "more"}
          title="Ещё клавиши"
          onTap={() => setPanel((p) => (p === "more" ? null : "more"))}
        />
        <Key label="⌨" title="Показать/скрыть клавиатуру" onTap={toggleKeyboard} />
      </div>

      {/* Row 2 — Ctrl+C, arrows, Enter. */}
      <div className="flex gap-1.5 px-2 py-1.5">
        <Key label="⌃C" onTap={() => onSend("\x03")} title="Ctrl+C" />
        <Key label="←" onTap={() => emitRaw(ARROWS.left)} />
        <Key label="↑" onTap={() => emitRaw(ARROWS.up)} />
        <Key label="↓" onTap={() => emitRaw(ARROWS.down)} />
        <Key label="→" onTap={() => emitRaw(ARROWS.right)} />
        <Key label="↵" onTap={() => onSend("\r")} title="Enter" />
      </div>
    </div>
  );
}
