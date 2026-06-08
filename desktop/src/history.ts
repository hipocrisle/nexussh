// Thin TypeScript wrapper around the Rust session-history commands.
//
// History records every byte of every interactive session to disk (the bytes
// are stored encrypted under the vault key). Listing/reading therefore requires
// the vault to be unlocked — those commands throw a "vault locked"-ish error
// otherwise, which we propagate verbatim so the UI can prompt for unlock.
//
// invoke arg-key convention: Tauri auto-converts camelCase JS keys to the Rust
// command's snake_case parameter names (see ssh.ts `sshSend` → `sessionId`,
// sftp.ts → `sftpId`). We follow the same camelCase convention here.

import { invoke } from "@tauri-apps/api/core";

const HAS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Per-session metadata as serialized by Rust serde (snake_case JSON keys). */
export interface SessionMeta {
  id: string;
  host_id: string;
  label: string;
  /** Unix seconds when the session started. */
  start: number;
  /** Unix seconds when the session ended, or null if still open / unknown. */
  end: number | null;
  /** Uncompressed byte volume of the recorded output ("source volume"). */
  bytes: number;
  cols: number;
  rows: number;
  /** Capture mode: "light" or "full". */
  mode: string;
  /** True if the recording hit its size cap and was truncated. */
  truncated: boolean;
}

export interface HistoryStats {
  sessions: number;
  bytes: number;
}

/** List all recordings, newest first. Throws if the vault is locked. */
export async function historyList(): Promise<SessionMeta[]> {
  if (!HAS_TAURI) return [];
  return await invoke<SessionMeta[]>("history_list");
}

/** Read a recording's raw NDJSON event stream. Throws if the vault is locked. */
export async function historyRead(id: string): Promise<string> {
  if (!HAS_TAURI) return "";
  return await invoke<string>("history_read", { id });
}

export async function historyDelete(id: string): Promise<void> {
  if (!HAS_TAURI) return;
  await invoke("history_delete", { id });
}

/** Delete every recording; returns how many were removed. */
export async function historyClear(): Promise<number> {
  if (!HAS_TAURI) return 0;
  return await invoke<number>("history_clear");
}

export async function historyStats(): Promise<HistoryStats> {
  if (!HAS_TAURI) return { sessions: 0, bytes: 0 };
  return await invoke<HistoryStats>("history_stats");
}

/** Begin recording for a live session. */
export async function historyStart(
  sessionId: string,
  hostId: string,
  label: string,
  cols: number,
  rows: number,
  mode: string,
): Promise<void> {
  if (!HAS_TAURI) return;
  await invoke("history_start", {
    sessionId,
    hostId,
    label,
    cols,
    rows,
    mode,
  });
}

/** Pause (or resume) recording for a live session. */
export async function historyPause(
  sessionId: string,
  paused: boolean,
): Promise<void> {
  if (!HAS_TAURI) return;
  await invoke("history_pause", { sessionId, paused });
}
