// Thin TypeScript wrapper around the Rust SSH local-port-forward commands
// (ssh -L). One open tunnel binds 127.0.0.1:localPort and pipes it to
// remoteHost:remotePort over the SSH connection.

import { invoke } from "@tauri-apps/api/core";
import type { ConnectArgs } from "./ssh";

/** Persisted, per-host forward definition (lives on the HostRecord). */
export interface PortForward {
  id: string;
  name?: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  scheme?: "http" | "https";
  /** Optional URL path appended on "open in browser" (e.g. a 3x-ui panel that
   *  lives under "/secret/"). Normalized to exactly one leading slash. */
  path?: string;
  autoStart?: boolean;
}

/** Build the "open in browser" URL for a forward, normalizing the path so it
 *  always has exactly one leading slash (empty/blank path → bare root). */
export function buildOpenUrl(
  scheme: "http" | "https",
  localPort: number,
  path?: string,
): string {
  const p = (path ?? "").trim();
  const suffix = p === "" ? "" : "/" + p.replace(/^\/+/, "");
  return `${scheme}://localhost:${localPort}${suffix}`;
}

/** A live tunnel as reported by the backend. */
export interface TunnelInfo {
  id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  label: string;
}

export async function tunnelOpen(
  args: ConnectArgs,
  fwd: {
    localPort: number;
    remoteHost: string;
    remotePort: number;
    label: string;
  },
): Promise<TunnelInfo> {
  return await invoke<TunnelInfo>("ssh_tunnel_open", {
    args,
    localPort: fwd.localPort,
    remoteHost: fwd.remoteHost,
    remotePort: fwd.remotePort,
    label: fwd.label,
  });
}

export async function tunnelClose(id: string): Promise<void> {
  await invoke("ssh_tunnel_close", { id });
}

export async function tunnelList(): Promise<TunnelInfo[]> {
  return await invoke<TunnelInfo[]>("ssh_tunnel_list");
}
