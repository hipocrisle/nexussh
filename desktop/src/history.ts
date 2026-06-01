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
 *  the live terminal writes raw bytes and is unaffected. */
export function filterAltBuffer(s: string): string {
  return (
    s
      // 1. Alt-screen toggles (ESC[?1049/1048/1047/47 h|l) — flatten TUI
      //    redraws (Claude Code / vim / htop) into the main buffer instead of
      //    vanishing when the app exits alt-screen.
      .replace(/\x1b\[\?(?:1049|1048|1047|47)[hl]/g, "")
      // 2. ESC[3J — erase scrollback. `clear` / `tput clear` emit it (usually
      //    as ESC[H ESC[2J ESC[3J). Honoring it during replay wipes the entire
      //    recorded history, leaving only post-clear output — the user sees
      //    "only the tail". Strip it so the full session remains scrollable.
      .replace(/\x1b\[3J/g, "")
  );
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
