// Thin TypeScript wrapper around the Rust local-filesystem commands. Used by
// the dual-pane SFTP file manager to browse the local disk (read-only); copies
// reuse the streaming sftp_upload / sftp_download commands.

import { invoke } from "@tauri-apps/api/core";

/** A local directory entry (matches the Rust `LocalEntry` struct). */
export interface LocalEntry {
  name: string;
  is_dir: boolean;
  /** Size in bytes (0 for directories). */
  size: number;
  /** Unix mtime in seconds (0 if unavailable). */
  mtime: number;
}

/** The user's home directory (falls back to "/"). */
export async function localHome(): Promise<string> {
  return await invoke<string>("fs_local_home");
}

/** List a local directory (dirs first, case-insensitive by name). */
export async function localList(path: string): Promise<LocalEntry[]> {
  return await invoke<LocalEntry[]>("fs_local_list", { path });
}

/** Size of a local file in bytes (0 if it doesn't exist / isn't readable). */
export async function localSize(path: string): Promise<number> {
  return await invoke<number>("fs_local_size", { path });
}

/**
 * Available local drive roots. On Windows these are the existing drive letters
 * (e.g. ["C:\\", "D:\\"]); on Linux/mac it's just ["/"]. The UI shows a drive
 * picker only when more than one root is returned.
 */
export async function localDrives(): Promise<string[]> {
  return await invoke<string[]>("fs_local_drives");
}

/** Create a single new local directory (errors if the parent doesn't exist). */
export async function localMkdir(path: string): Promise<void> {
  await invoke("fs_local_mkdir", { path });
}

/** Rename / move a local entry (file or directory). */
export async function localRename(from: string, to: string): Promise<void> {
  await invoke("fs_local_rename", { from, to });
}

/** Delete a local entry (recursively for a directory). Confirm in the UI first. */
export async function localDelete(path: string): Promise<void> {
  await invoke("fs_local_delete", { path });
}
