// Thin TypeScript wrapper around our Rust Tauri commands.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { VpnNode } from "./vpn";
import { vaultGet, hostKeyDataKey } from "./vault";

export type AuthMethod =
  | { kind: "password"; password: string }
  | { kind: "key"; path: string; passphrase?: string; content?: string }
  | { kind: "vault"; key: string };

/** Persisted host-record auth (key has NO secrets — they live in the vault). */
export type StoredAuth =
  | { kind: "password"; password: string }
  | { kind: "key" }
  | { kind: "vault"; key: string };

/** Turn a persisted auth into a runtime AuthMethod. For key-auth, the private-key
 *  path + passphrase are read from the LOCAL vault (hostKeyDataKey) — never from
 *  the synced record. Missing/locked vault → empty path so the backend reports a
 *  clear "key not set on this device" error (e.g. after sync to a new machine). */
export async function resolveAuth(auth: StoredAuth, hostId: string): Promise<AuthMethod> {
  if (auth.kind !== "key") return auth;
  try {
    const raw = await vaultGet(hostKeyDataKey(hostId));
    const d = JSON.parse(raw) as { path?: string; passphrase?: string; content?: string };
    return {
      kind: "key",
      path: d.path ?? "",
      passphrase: d.passphrase || undefined,
      content: d.content || undefined,
    };
  } catch {
    return { kind: "key", path: "", passphrase: undefined };
  }
}

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
  /** Opt-in to weak legacy algorithms for old gear. OFF by default. */
  allow_legacy?: boolean;
  /** When host-list encryption is on, pin host keys in the vault not the file. */
  encrypt_known_hosts?: boolean;
  /** Connect-phase timeout in seconds (TCP connect + SSH handshake). 0/absent
   *  falls back to a sane default backend-side. Separate from keepalive. */
  timeout?: number;
  /** Post-connect keepalive interval in seconds. 0/absent uses the backend
   *  default (does NOT disable keepalive). */
  keepalive?: number;
  /** Record this session to encrypted history (started backend-side before the
   *  output loop, so the banner/prompt isn't missed). */
  record_history?: boolean;
  history_mode?: string;
  history_host_id?: string;
  history_label?: string;
}

export interface DataEvent {
  session_id: string;
  data: number[]; // Vec<u8> serializes to JSON number array
}

export interface ClosedEvent {
  session_id: string;
  reason: string;
}

export interface HostKeyPromptInfo {
  host: string;
  port: number;
  fingerprint: string;
  /** true = the pinned key CHANGED (possible MITM); false = new/unpinnable. */
  changed: boolean;
}
/** Registered once by the app: shows a PuTTY-style "accept host key?" dialog and
 *  resolves true if the user accepts. Without it, an unverified key just errors. */
let hostKeyPrompt: ((info: HostKeyPromptInfo) => Promise<boolean>) | null = null;
export function setHostKeyPrompt(
  fn: (info: HostKeyPromptInfo) => Promise<boolean>,
) {
  hostKeyPrompt = fn;
}

export async function sshConnect(
  args: ConnectArgs,
  _retry = false,
): Promise<{ sessionId: string; recording: boolean }> {
  // Reachability guard — the single choke-point every connect path goes through
  // (saved-password/key/vault hosts skip the askPassword probe, so guarding only
  // there leaves a hole). A bogus/offline host fails fast here with a clear
  // message instead of a long SSH-handshake hang mistaken for bad creds. Skip
  // VPN hosts (they reach the target via the SOCKS path). Fail-open if the probe
  // itself errors, so a probe glitch never blocks a real connection.
  if (!args.vpn) {
    const reachable = await hostReachable(args.host, args.port, 5).catch(
      () => true,
    );
    if (!reachable) throw `Хост недоступен: ${args.host}:${args.port}`;
  }
  try {
    const res = await invoke<{ session_id: string; recording: boolean }>(
      "ssh_connect",
      { args },
    );
    return { sessionId: res.session_id, recording: !!res.recording };
  } catch (e) {
    // Host key not pinned (new host that couldn't auto-pin, or the key CHANGED) →
    // prompt the user once; on accept, pin the key and re-connect.
    if (
      !_retry &&
      e &&
      typeof e === "object" &&
      (e as { kind?: string }).kind === "host_key_unverified" &&
      hostKeyPrompt
    ) {
      const info = e as unknown as HostKeyPromptInfo;
      const accepted = await hostKeyPrompt(info);
      if (!accepted) throw "Подключение отменено: ключ хоста не принят";
      await invoke("ssh_pin_host_key", {
        host: info.host,
        port: info.port,
        fingerprint: info.fingerprint,
        encryptKnownHosts: args.encrypt_known_hosts ?? false,
      });
      return sshConnect(args, true);
    }
    // Attach the captured SSH protocol trace (KEX / host-key / auth / disconnect)
    // so a cryptic failure like "Channel send error" shows what actually happened.
    let log = "";
    try {
      log = await invoke<string>("ssh_debug_log");
    } catch {
      /* logging unavailable — keep the bare error */
    }
    throw log ? `${e}\n\n— SSH-протокол —\n${log}` : String(e);
  }
}

/** Pre-auth TCP reachability probe (host:port) — used before asking for a
 *  password so an offline host is reported as unreachable, not mistaken for a
 *  wrong password. Direct path only (VPN hosts are skipped by the caller). */
export async function hostReachable(
  host: string,
  port: number,
  timeoutSecs: number,
): Promise<boolean> {
  return invoke<boolean>("host_reachable", {
    host,
    port,
    timeoutSecs,
  });
}

/** Quick-connect reachability check (connect-modal step 11): resolves to the
 *  round-trip TCP connect time in ms, or REJECTS on timeout/refusal. */
export async function tcpPing(
  host: string,
  port: number,
  timeoutMs = 8000,
): Promise<number> {
  return invoke<number>("tcp_ping", { host, port, timeoutMs });
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
