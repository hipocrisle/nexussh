// Thin TypeScript wrapper around the Rust SFTP commands.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { ConnectArgs } from "./ssh";

export interface SftpEntry {
  name: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  /** Unix mtime in seconds (0 if unknown). */
  mtime: number;
  /** POSIX mode bits (0 if unknown). */
  permissions: number;
  /** Owner user name if the server reports it (else ""). */
  owner: string;
  /** Numeric uid (0 if unknown). */
  uid: number;
}

export async function sftpConnect(args: ConnectArgs): Promise<string> {
  const { sftp_id } = await invoke<{ sftp_id: string }>("sftp_connect", {
    args,
  });
  return sftp_id;
}

export async function sftpRealpath(
  sftpId: string,
  path: string,
): Promise<string> {
  return await invoke<string>("sftp_realpath", { sftpId, path });
}

export async function sftpList(
  sftpId: string,
  path: string,
): Promise<SftpEntry[]> {
  return await invoke<SftpEntry[]>("sftp_list", { sftpId, path });
}

/** Progress event for an in-flight transfer (`total === 0` means unknown). */
export interface SftpProgress {
  id: string;
  transferred: number;
  total: number;
  phase: "download" | "upload";
}

export async function sftpDownload(
  sftpId: string,
  remotePath: string,
  localPath: string,
  transferId: string,
  resume = false,
): Promise<void> {
  await invoke("sftp_download", {
    sftpId,
    remotePath,
    localPath,
    transferId,
    resume,
  });
}

export async function sftpUpload(
  sftpId: string,
  localPath: string,
  remotePath: string,
  transferId: string,
  resume = false,
): Promise<void> {
  await invoke("sftp_upload", {
    sftpId,
    localPath,
    remotePath,
    transferId,
    resume,
  });
}

/**
 * Upload raw bytes to a remote path (mobile path — avoids the content:// URI an
 * Android file picker returns, which the streaming sftp_upload can't open). The
 * frontend reads the picked file via the File API and ships the bytes here.
 */
export async function sftpWriteBytes(
  sftpId: string,
  remotePath: string,
  data: Uint8Array,
  transferId: string,
): Promise<void> {
  await invoke("sftp_write_bytes", { sftpId, remotePath, data, transferId });
}

/** Download a remote file as raw bytes (mobile path — turned into a Blob for
 *  saving). Returns the file contents as a Uint8Array. */
export async function sftpReadBytes(
  sftpId: string,
  remotePath: string,
  transferId: string,
): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("sftp_read_bytes", {
    sftpId,
    remotePath,
    transferId,
  });
  return new Uint8Array(buf);
}

/**
 * Error message a download/upload promise rejects with when the user cancelled
 * it (matches the Rust `CANCELLED` sentinel). Callers treat this as a normal
 * user-cancel rather than a real failure. Tauri surfaces command errors as
 * strings, so the rejection's stringified form ends with this token.
 */
export const SFTP_CANCELLED = "cancelled";

/** True if a download/upload rejection was a user cancellation, not a failure. */
export function isCancelled(e: unknown): boolean {
  return String(e).includes(SFTP_CANCELLED);
}

/** Ask the backend to stop an in-flight transfer (by its transferId). */
export async function sftpCancel(id: string): Promise<void> {
  await invoke("sftp_cancel", { id });
}

export function onSftpProgress(
  cb: (p: SftpProgress) => void,
): Promise<UnlistenFn> {
  return listen<SftpProgress>("sftp-progress", (e) => cb(e.payload));
}

export async function sftpChmod(
  sftpId: string,
  path: string,
  mode: number,
): Promise<void> {
  await invoke("sftp_chmod", { sftpId, path, mode });
}

/**
 * Recursively chmod a directory and everything under it. Returns the number of
 * entries touched. Symlinks are chmod'd as the link entry and are NOT followed
 * into other trees. Use only for directory targets; plain files use sftpChmod.
 */
export async function sftpChmodRecursive(
  sftpId: string,
  path: string,
  mode: number,
): Promise<number> {
  return await invoke<number>("sftp_chmod_recursive", { sftpId, path, mode });
}

/** Result of reading a remote file as text for the built-in viewer/editor. */
export interface SftpTextRead {
  /** UTF-8 (lossy) content. Empty when `too_large`. */
  content: string;
  /** First `max_bytes` only — the file is larger. VIEW may show it; EDIT refuses. */
  truncated: boolean;
  /** File exceeds `max_bytes`; no content returned. EDIT refuses. */
  too_large: boolean;
  /** Read window contains NUL bytes — likely binary; UI warns + refuses edit. */
  binary: boolean;
  /** Full file size in bytes (0 if unknown). */
  size: number;
}

/**
 * Read a remote text file (up to `maxBytes`) for the built-in viewer/editor.
 * A file larger than `maxBytes` comes back with `too_large` (no content) — use
 * the streaming download for big files. Binary content is flagged, not shown.
 */
export async function sftpReadText(
  sftpId: string,
  path: string,
  maxBytes: number,
): Promise<SftpTextRead> {
  return await invoke<SftpTextRead>("sftp_read_text", { sftpId, path, maxBytes });
}

/**
 * Overwrite a remote text file with `content` (UTF-8), truncating to the new
 * length. The existing file mode is preserved when the server reports it.
 */
export async function sftpWriteText(
  sftpId: string,
  path: string,
  content: string,
): Promise<void> {
  await invoke("sftp_write_text", { sftpId, path, content });
}

export async function sftpMkdir(sftpId: string, path: string): Promise<void> {
  await invoke("sftp_mkdir", { sftpId, path });
}

export async function sftpRename(
  sftpId: string,
  from: string,
  to: string,
): Promise<void> {
  await invoke("sftp_rename", { sftpId, from, to });
}

export async function sftpRemove(
  sftpId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  await invoke("sftp_remove", { sftpId, path, isDir });
}

export async function sftpDisconnect(sftpId: string): Promise<void> {
  await invoke("sftp_disconnect", { sftpId });
}
