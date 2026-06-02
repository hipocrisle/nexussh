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

/** Reconstruct scrollable history from a recorded cast.
 *
 *  For tmux / alt-screen sessions a plain `term.write(raw)` only ever shows
 *  the final frame (alt-screen has no scrollback). To get *scrollable*
 *  history we replay into a wide offscreen terminal with the alt-screen
 *  toggles stripped, so every line tmux painted flows into scrollback,
 *  then return the clean lines.
 *
 *  The single dominant noise is tmux's status bar, which it repaints every
 *  second — hundreds of `[claude] 0:claude*  …  "host · Claude Code" 14:18
 *  02-Jun` rows. We drop those (plus Claude Code's own spinner/footer) and
 *  globally de-duplicate identical lines so nothing doubles. */
export function reconstructHistory(raw: string): string {
  const noAlt = raw.replace(/\x1b\[\?(?:1049|1048|1047|47)[hl]/g, "");
  return noAlt;
}

/** A tmux status-bar row. Killer signal: the clock+date tmux pins to the
 *  right edge (`14:18 02-Jun` / `14:18 02-Jun-26`). Also the window list
 *  `0:claude*` when a `]` (session name bracket) is on the line. */
export function isTmuxStatusRow(line: string): boolean {
  if (
    /\b\d{1,2}:\d{2}\s+\d{1,2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(
      line,
    )
  )
    return true;
  if (/\]\s*\d+:[\w.\-]+[*\-]/.test(line)) return true;
  return false;
}

/** Claude Code chrome (spinner, status footer, prompt box) that repaints
 *  in the bottom region and leaves frames in reconstructed scrollback. */
export function isClaudeChrome(line: string): boolean {
  // Spinner glyphs Claude Code cycles through.
  if (/^\s*[✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋✢✣✤✥✦✧✩✪✫✬✭✮✯✰]/.test(line))
    return true;
  // Spinner / completion signatures, leading char agnostic.
  if (/·\s*↓\s*[\d.]+k?\s*tokens/.test(line)) return true;
  if (/\bfor \d+(?:\.\d+)?s\b\s*·/.test(line)) return true;
  if (/\besc to interrupt\b/.test(line)) return true;
  if (/accept edits on/.test(line)) return true;
  if (/ctrl\+t to (?:hide|show) tasks/.test(line)) return true;
  if (/⏵⏵/.test(line)) return true;
  return false;
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
