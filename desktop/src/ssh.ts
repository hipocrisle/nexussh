// Thin TypeScript wrapper around our Rust Tauri commands.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { VpnNode } from "./vpn";

export type AuthMethod =
  | { kind: "password"; password: string }
  | { kind: "key"; path: string; passphrase?: string }
  | { kind: "vault"; key: string };

export interface ConnectArgs {
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  cols?: number;
  rows?: number;
  /** When set, route the SSH connection through the built-in xray SOCKS proxy
   *  egressing via this node. */
  vpn?: VpnNode | null;
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

/**
 * Tell the backend that our `ssh-data` event listener is attached. The
 * backend buffers output from connect-time until this fires, then flushes
 * everything through the same channel — otherwise fast servers (Keenetic,
 * mikrotik, …) drop their prelogin banner into the void before the JS
 * listener has finished attaching.
 */
export async function sshReady(sessionId: string): Promise<void> {
  await invoke("ssh_ready", { sessionId });
}

export function onSshData(handler: (ev: DataEvent) => void): Promise<UnlistenFn> {
  return listen<DataEvent>("ssh-data", (e) => handler(e.payload));
}

export function onSshClosed(
  handler: (ev: ClosedEvent) => void,
): Promise<UnlistenFn> {
  return listen<ClosedEvent>("ssh-closed", (e) => handler(e.payload));
}
