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
  autoStart?: boolean;
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
