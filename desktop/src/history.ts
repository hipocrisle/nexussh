// Session history — TS bindings to backend history_* commands.

import { invoke } from "@tauri-apps/api/core";

export interface HistoryEntry {
  session_id: string;
  host: string;
  port: number;
  user: string;
  started_at: string;
  ended_at: string | null;
  byte_count: number;
  still_active: boolean;
  /** Terminal dimensions at session start. May be 0 for legacy sessions. */
  cols: number;
  rows: number;
}

export interface SearchHit {
  session_id: string;
  host: string;
  started_at: string;
  line: string;
}

export async function historyList(): Promise<HistoryEntry[]> {
  return await invoke<HistoryEntry[]>("history_list");
}

export async function historyRead(sessionId: string): Promise<Uint8Array> {
  const arr = await invoke<number[]>("history_read", { sessionId });
  return new Uint8Array(arr);
}

export interface CastEvent {
  /** seconds since session start */
  t: number;
  /** utf-8 chunk (may contain ANSI escapes) */
  d: string;
}

export async function historyReadEvents(
  sessionId: string,
): Promise<CastEvent[]> {
  return await invoke<CastEvent[]>("history_read_events", { sessionId });
}

/** Sanitize a recorded chunk for REPLAY (History viewer / Transcript overlay)
 *  so the whole session stays as scrollable history. Runs only on replay —
 *  the live terminal writes raw bytes and is unaffected.
 *
 *  Operates on the FULL session text (events concatenated) so it can
 *  match across event boundaries — an alt-screen window can easily span
 *  hundreds of small chunks.
 */
export function filterAltBuffer(s: string): string {
  // 1. Drop the ENTIRE alt-screen window (open marker + body + close
  //    marker). Without this the body — full of cursor-position and
  //    erase-line escapes targeted at the alt buffer — gets applied to
  //    the main buffer instead, drawing TUI redraws on top of one
  //    another. Result: unreadable wall of stacked characters whenever
  //    the session ran Claude Code / vim / htop / etc.
  //
  //    Old code stripped only the toggles (`[?1049h` / `[?1049l`) which
  //    is the worst of both worlds — alt-screen "content" leaks into
  //    main buffer with no alt context to position it.
  //
  //    Variants 1049/1048/1047/47 are all equivalent for our purposes
  //    (different historical xterm modes for save/restore + alt screen).
  //    The lazy regex `[\s\S]*?` makes sure we don't span multiple
  //    independent alt-windows.
  //
  //    If the recording ends mid-alt-screen (no closing toggle), drop
  //    everything from the opening marker to the end of the buffer so
  //    we don't leave the body dangling.
  let out = s
    .replace(/\x1b\[\?(?:1049|1048|1047|47)h[\s\S]*?\x1b\[\?(?:1049|1048|1047|47)l/g, "")
    .replace(/\x1b\[\?(?:1049|1048|1047|47)h[\s\S]*$/g, "");
  // 2. ESC[3J — erase scrollback. `clear` / `tput clear` emit it (usually
  //    as ESC[H ESC[2J ESC[3J). Honoring it during replay wipes the entire
  //    recorded history, leaving only post-clear output — the user sees
  //    "only the tail". Strip so the full session remains scrollable.
  out = out.replace(/\x1b\[3J/g, "");
  return out;
}

// All known Claude Code spinner glyphs. They rotate through the asterisk
// family in the Unicode Dingbats block + ASCII `*`. Any line that starts
// with one of these followed by a space is almost certainly chrome.
const CC_SPINNER_GLYPHS = "*✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋✢✣✤✥✦✧✩✪✫✬✭✮✯✰";

/** Detect a Claude Code "chrome" line — status footer, spinner, prompt box,
 *  task list, confirmation prompts — that's noise when reading back a
 *  session. User: «нельзя из истории удалять (фильтровать) твои системные
 *  таски и оставлять только мои вводы и твои ответы?» — yes, drop. */
export function isClaudeChromeLine(line: string): boolean {
  // Status footer: "⏵⏵ accept edits on · 3 shells · …"
  if (/^⏵⏵\s+accept edits/.test(line)) return true;
  // Prompt-box separator (long horizontal run).
  if (/^─{20,}\s*$/.test(line)) return true;
  // Empty prompt arrow / Yes-No confirmation choices.
  if (/^❯\s*$/.test(line)) return true;
  if (/^❯\s*\d+\.\s*(Yes|No)/.test(line)) return true;
  if (/^\s*\d+\.\s+(Yes|No)\b/.test(line)) return true;
  if (/^\s*(Yes|No),?\s*$/.test(line)) return true;
  if (/^\s*(Esc to cancel|Tab to amend|Do you want to proceed)/.test(line)) return true;
  if (/^Bash command\s*$/.test(line)) return true;
  // Spinner with any glyph + verb in -ing or -ed form.
  const glyphClass = `[${CC_SPINNER_GLYPHS}]`;
  if (new RegExp(`^${glyphClass}\\s+\\S+`).test(line)) {
    // Has timer / tokens / shells / verb-ing / for X — chrome.
    if (/(?:\d+s\b|tokens\)|shells still running|Waiting|for\s+(?:\d+h)? ?(?:\d+m)? ?\d+s)/.test(line)) return true;
    if (/\b\w+ing\b/.test(line)) return true; // "Building", "Cooking", "Brewing"
    if (/\b(Cooked|Brewed|Baked|Sautéed|Churned|Whisked|Beaten|Blended|Toasted|Glazed|Mashed|Steamed|Stewed|Simmered)\b/.test(line)) return true;
  }
  // Task list header and rows.
  if (/^\d+ tasks \(\d+ done, \d+ in progress, \d+ open\)/.test(line)) return true;
  if (/^\s*(?:⎿\s+)?[◼◻]\s/.test(line)) return true;
  // Pending/completed/lines summary marker.
  if (/^\s*…\s+\+\d+\s+(pending|completed|lines)/.test(line)) return true;
  // ⎿ Waiting… / ⎿ (No output)
  if (/^\s*⎿\s+(Waiting|\(No output\)|Running…)/.test(line)) return true;
  // Trailing isolated "…" / single-char animation residue.
  if (/^\s*…\s*$/.test(line)) return true;
  return false;
}

/** Detect a tmux status-bar line so REPLAY (transcript / history) can skip it.
 *  Each tmux redraw of the bottom status row gets captured to the cast; in
 *  long sessions that ends up as dozens of "[claude] 0:claude*" snapshots
 *  in scrollback, all functionally identical. Anchored regex matches the
 *  unmistakable `[<name>] <num>:<name>[*+-!~]?` window-list prefix.
 *
 *  Easy to revert: delete this function + the single call site in
 *  TranscriptOverlay.tsx and HistoryPanel.tsx.
 */
export function isTmuxStatusLine(line: string): boolean {
  const plain = line
    .replace(/\x1b\[[\d;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b./g, "");
  return /^\s*\[[\w-]+\]\s+\d+:[\w-]+[\*+\-!~]?\b/.test(plain);
}

export async function historyDelete(sessionId: string): Promise<void> {
  await invoke("history_delete", { sessionId });
}

export async function historySearch(query: string): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>("history_search", { query });
}

export async function historyExport(
  sessionId: string,
  outPath: string,
  strip: boolean,
): Promise<void> {
  await invoke("history_export", { sessionId, outPath, strip });
}

/** Strip ANSI/OSC/SS2/SS3 + charset/DCS escapes for the "Plain text"
 *  transcript toggle.
 *
 *  TUI sessions (Claude Code / vim / htop) draw by cursor positioning,
 *  not newlines. Naive regex stripping either glued everything into one
 *  blob (v1.0.30: no whitespace between rows) or split every word onto
 *  its own line (v1.0.32: staircase, because `\x1b[5;1Haccept \x1b[5;8Hedits`
 *  became two newlines).
 *
 *  This pass simulates a 1-row buffer of "what's currently being painted":
 *  - text accumulates into a buffer
 *  - cursor moves to a different row, or a "line restart" (jump back to
 *    col 1 on the same row), flush the buffer as one output line
 *  - cursor moves forward on the same row insert a space separator
 *
 *  Result: each row of the TUI surface = one output line. Caller's
 *  adjacent-line dedup then collapses identical status-row redraws to
 *  a single copy. */
export function stripAnsiString(s: string): string {
  const out: string[] = [];
  let buf = "";
  let row = 1;
  let col = 1;

  const flush = () => {
    out.push(buf);
    buf = "";
  };
  const pad = () => {
    if (buf.length > 0 && !buf.endsWith(" ")) buf += " ";
  };

  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);

    if (c === 0x1b) {
      const next = s[i + 1];

      if (next === "[") {
        // CSI ESC [ <params> <final>
        let j = i + 2;
        let params = "";
        while (j < s.length) {
          const cc = s.charCodeAt(j);
          if (cc >= 0x40 && cc <= 0x7e) break;
          params += s[j];
          j++;
        }
        const fin = s[j] || "";
        i = j + 1;
        const nums = params
          .replace(/^\?/, "")
          .split(";")
          .map((p) => parseInt(p, 10) || 0);

        if (fin === "H" || fin === "f") {
          const r = nums[0] || 1;
          const c2 = nums[1] || 1;
          // New row OR jump back to an earlier column = line restart.
          if (r !== row || c2 < col) {
            flush();
            row = r;
            col = c2;
          } else if (c2 > col) {
            pad();
            col = c2;
          }
        } else if (fin === "A") {
          flush();
          row = Math.max(1, row - (nums[0] || 1));
          col = 1;
        } else if (fin === "B" || fin === "E") {
          flush();
          row += nums[0] || 1;
          col = 1;
        } else if (fin === "F") {
          flush();
          row = Math.max(1, row - (nums[0] || 1));
          col = 1;
        } else if (fin === "C") {
          pad();
          col += nums[0] || 1;
        } else if (fin === "D") {
          col = Math.max(1, col - (nums[0] || 1));
        } else if (fin === "G") {
          const cAbs = nums[0] || 1;
          if (cAbs < col) flush();
          else if (cAbs > col) pad();
          col = cAbs;
        }
        // J, K, m, h, l, r, s, u, t and friends — strip silently.
        continue;
      }

      if (next === "]") {
        // OSC: ESC ] … BEL or ESC ] … ESC\
        let j = i + 2;
        while (j < s.length) {
          if (s.charCodeAt(j) === 0x07) {
            j++;
            break;
          }
          if (s.charCodeAt(j) === 0x1b && s[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      if (next === "P" || next === "X" || next === "^" || next === "_") {
        // DCS / SOS / PM / APC
        let j = i + 2;
        while (j < s.length) {
          if (s.charCodeAt(j) === 0x07) {
            j++;
            break;
          }
          if (s.charCodeAt(j) === 0x1b && s[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      if (next && "()*+-./NO".includes(next)) {
        // Charset designation + SS2/SS3: ESC <byte> <byte>
        i += 3;
        continue;
      }

      // Other 2-byte escapes (ESC 7, ESC 8, ESC c, ESC =, ESC >, etc.)
      i += 2;
      continue;
    }

    if (c === 0x0a) {
      // LF
      flush();
      row++;
      col = 1;
      i++;
      continue;
    }
    if (c === 0x0d) {
      // CR — reset column but don't emit a new line yet (next H/text will).
      col = 1;
      i++;
      continue;
    }
    if (c === 0x09) {
      buf += "\t";
      col += 8;
      i++;
      continue;
    }
    if (c < 0x20 || c === 0x7f) {
      // Drop other control bytes.
      i++;
      continue;
    }

    // Visible character.
    buf += s[i];
    col++;
    i++;
  }
  flush();

  // CRLF — xterm needs the CR or the cursor stays at the column where the
  // previous line ended, producing a diagonal drift down-and-right
  // ("каждая строка начинается чуть правее предыдущей").
  const joined = out.join("\r\n");
  return joined.replace(/(?:\r\n){3,}/g, "\r\n\r\n");
}

/** Strip ANSI escape sequences in JS for in-app display.
 *  Mirrors the Rust strip_ansi in backend, but we keep the raw bytes server-side
 *  so user can export with ANSI preserved if desired. */
export function stripAnsi(bytes: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c === 0x1b) {
      if (i + 1 >= bytes.length) {
        i += 1;
        continue;
      }
      const next = bytes[i + 1];
      if (next === 0x5b) {
        // CSI [
        i += 2;
        while (i < bytes.length) {
          const b = bytes[i];
          i += 1;
          if (b >= 0x40 && b <= 0x7e) break;
        }
      } else if (next === 0x5d) {
        // OSC ]
        i += 2;
        while (i < bytes.length) {
          if (bytes[i] === 0x07) {
            i += 1;
            break;
          }
          if (
            bytes[i] === 0x1b &&
            i + 1 < bytes.length &&
            bytes[i + 1] === 0x5c
          ) {
            i += 2;
            break;
          }
          i += 1;
        }
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        // DCS/SOS/PM/APC
        i += 2;
        while (i < bytes.length) {
          if (bytes[i] === 0x07) {
            i += 1;
            break;
          }
          if (
            bytes[i] === 0x1b &&
            i + 1 < bytes.length &&
            bytes[i + 1] === 0x5c
          ) {
            i += 2;
            break;
          }
          i += 1;
        }
      } else if (next === 0x4e || next === 0x4f) {
        // SS2 / SS3 — `ESC N <c>` / `ESC O <c>` — three bytes total.
        // Without this branch, arrow-key escapes from mouse-wheel events
        // (`\x1bOA`/`\x1bOB`) leak their trailing letter into the log.
        i += Math.min(3, bytes.length - i);
      } else {
        i += 2;
      }
      continue;
    }
    if (c === 0x0a || c === 0x0d || c === 0x09 || c >= 0x20) {
      out.push(c);
    }
    i += 1;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(out));
}

/** Format `@1716800000s` as a short locale-aware datetime. */
export function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  const m = ts.match(/^@(\d+)s$/);
  if (!m) return ts;
  const d = new Date(parseInt(m[1], 10) * 1000);
  return d.toLocaleString();
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
