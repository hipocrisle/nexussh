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

/** Sanitize a recorded chunk for REPLAY (History viewer / Transcript overlay).
 *
 *  Goal: bytes that were authored against a 2D screen (cursor positioning,
 *  alt-screen redraws, line erases) become a LINEAR scrollable text stream
 *  in xterm's main buffer. The user can wheel up and read everything that
 *  ever streamed through the session, without text scribbling over itself.
 *
 *  Strategy: pass through SGR (colors), OSC (titles, hyperlinks), and
 *  private-mode toggles like cursor visibility. Strip everything that
 *  moves the cursor or erases parts of the screen — including the
 *  alt-screen entry/exit toggles themselves (so TUI content flattens into
 *  main rather than vanishing on exit).
 *
 *  Earlier versions kept positioning bytes; that left ESC[H / ESC[2J / ESC[K
 *  scribbling over already-written content in the replay's main buffer,
 *  which is what users perceived as "съехало и почти нечитаемо".
 */
export function filterAltBuffer(s: string): string {
  let out = "";
  let i = 0;
  const len = s.length;

  while (i < len) {
    const c = s.charCodeAt(i);

    // Plain byte (not ESC) → copy as-is.
    if (c !== 0x1b) {
      out += s[i];
      i++;
      continue;
    }

    // Need at least one byte after ESC to dispatch.
    if (i + 1 >= len) {
      i++;
      continue;
    }

    const next = s[i + 1];

    // ── CSI: ESC [ params final ────────────────────────────────────────
    if (next === "[") {
      const start = i;
      let j = i + 2;
      // Scan until final byte (0x40–0x7E).
      while (j < len) {
        const cc = s.charCodeAt(j);
        if (cc >= 0x40 && cc <= 0x7e) break;
        j++;
      }
      if (j >= len) {
        // Truncated CSI — drop it.
        i = len;
        continue;
      }
      const final = s[j];
      const params = s.slice(i + 2, j);
      const seqEnd = j + 1;

      // SGR (colors / bold / underline) — preserve, critical for readability.
      if (final === "m") {
        out += s.slice(start, seqEnd);
        i = seqEnd;
        continue;
      }

      // Alt-screen toggles: drop the toggle itself, insert a newline so
      // the flattened TUI content visually separates from prior output.
      if (/^\?(1049|1048|1047|47)$/.test(params) && (final === "h" || final === "l")) {
        out += "\r\n";
        i = seqEnd;
        continue;
      }

      // Cursor positioning / movement: H f A B C D E F G d ` → strip.
      // Erase: J K → strip (otherwise wipes already-written content).
      // Insert/delete/scroll: L M P X @ S T → strip.
      // Save/restore cursor, set scroll region: s u r → strip.
      if (/^[HfABCDEFGd`JKLMPX@STsur]$/.test(final)) {
        i = seqEnd;
        continue;
      }

      // Anything else (private modes ?25h/?7h/?2004h, DSR, etc.) — keep.
      out += s.slice(start, seqEnd);
      i = seqEnd;
      continue;
    }

    // ── OSC: ESC ] … ST/BEL ────────────────────────────────────────────
    if (next === "]") {
      const start = i;
      let j = i + 2;
      while (j < len) {
        const cc = s.charCodeAt(j);
        if (cc === 0x07) {
          j++;
          break;
        }
        if (cc === 0x1b && j + 1 < len && s[j + 1] === "\\") {
          j += 2;
          break;
        }
        j++;
      }
      out += s.slice(start, j);
      i = j;
      continue;
    }

    // ── Single-byte ESC commands that move/save cursor: skip.
    //   ESC c  (RIS, full reset)
    //   ESC 7  (DECSC, save cursor)   ESC 8  (DECRC, restore cursor)
    //   ESC D  (IND)  ESC E  (NEL)   ESC H  (HTS)   ESC M  (RI)
    if (
      next === "c" ||
      next === "7" ||
      next === "8" ||
      next === "D" ||
      next === "E" ||
      next === "H" ||
      next === "M"
    ) {
      i += 2;
      continue;
    }

    // Other 2-byte ESC sequences — keep.
    out += s[i];
    out += s[i + 1];
    i += 2;
  }

  return out;
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
