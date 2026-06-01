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
 *  transcript toggle. Best-effort — TUI sessions (Claude Code / vim /
 *  htop) draw by cursor positioning rather than newlines, so stripped
 *  output ends up as a single long run with no structure. We compensate
 *  by treating cursor-home moves and CRs as synthetic line breaks before
 *  stripping, so consecutive TUI repaints at least split into separate
 *  visible lines (and the caller's dedup collapses identical repaints
 *  next to each other). */
export function stripAnsiString(s: string): string {
  return (
    s
      // 1. Insert a synthetic newline BEFORE every cursor-home so each
      //    full-screen redraw lands on its own line — caller deduplicates
      //    identical neighbours, so an idle Claude Code prompt collapses
      //    to one copy instead of thousands.
      .replace(/\x1b\[(?:[01];[01])?[Hf]/g, "\n")
      // 2. OSC: ESC ] … BEL or ESC ] … ESC\
      .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "")
      // 3. DCS / SOS / PM / APC: ESC P|X|^|_ … ESC\ or BEL
      .replace(/\x1b[PX^_][\s\S]*?(\x07|\x1b\\)/g, "")
      // 4. CSI: ESC [ … final byte
      .replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, "")
      // 5. Charset designation: ESC ( B, ESC ) B, ESC * B, ESC + B, etc.
      //    These produce visible `(B` `)B` garbage in the user's output.
      .replace(/\x1b[()*+\-./][\w@-~]/g, "")
      // 6. SS2 / SS3 single-char: ESC N <c>, ESC O <c>
      .replace(/\x1b[NO]./g, "")
      // 7. Other single-char escapes (locking shifts, save/restore cursor,
      //    designate G2/G3, ESC c reset, ESC = ESC > app-kp, ESC 7/8 etc.)
      .replace(/\x1b[A-Z\\=78<>\d]/g, "")
      // 8. Any lingering ESC <byte> we missed.
      .replace(/\x1b./g, "")
      // 9. Control chars (keep \n \r \t).
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      // 10. Normalize CR/CRLF -> LF.
      .replace(/\r\n?/g, "\n")
  );
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
