// Thin TypeScript wrapper around our Rust Tauri commands.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type AuthMethod =
  | { kind: "password"; password: string }
  | { kind: "key"; path: string; passphrase?: string };

export interface ConnectArgs {
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  cols?: number;
  rows?: number;
}

export interface DataEvent {
  session_id: string;
  data: number[]; // Vec<u8> serializes to JSON number array
}

export interface ClosedEvent {
  session_id: string;
  reason: string;
}

export async function sshConnect(args: ConnectArgs): Promise<string> {
  const { session_id } = await invoke<{ session_id: string }>("ssh_connect", {
    args,
  });
  return session_id;
}

export async function sshSend(sessionId: string, data: Uint8Array): Promise<void> {
  await invoke("ssh_send", {
    sessionId,
    data: Array.from(data),
  });
}

export async function sshResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("ssh_resize", { sessionId, cols, rows });
}

export async function sshDisconnect(sessionId: string): Promise<void> {
  await invoke("ssh_disconnect", { sessionId });
}

export function onSshData(handler: (ev: DataEvent) => void): Promise<UnlistenFn> {
  return listen<DataEvent>("ssh-data", (e) => handler(e.payload));
}

export function onSshClosed(
  handler: (ev: ClosedEvent) => void,
): Promise<UnlistenFn> {
  return listen<ClosedEvent>("ssh-closed", (e) => handler(e.payload));
}
