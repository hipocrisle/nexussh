// Thin TypeScript wrapper around the Rust SFTP commands.

import { invoke } from "@tauri-apps/api/core";
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

export async function sftpDownload(
  sftpId: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  await invoke("sftp_download", { sftpId, remotePath, localPath });
}

export async function sftpUpload(
  sftpId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await invoke("sftp_upload", { sftpId, localPath, remotePath });
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
