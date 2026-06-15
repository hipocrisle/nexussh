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
): Promise<void> {
  await invoke("sftp_download", { sftpId, remotePath, localPath, transferId });
}

export async function sftpUpload(
  sftpId: string,
  localPath: string,
  remotePath: string,
  transferId: string,
): Promise<void> {
  await invoke("sftp_upload", { sftpId, localPath, remotePath, transferId });
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
