// Built-in VPN transport — client side. Profiles (a subscription URL + its
// parsed nodes) are stored locally per machine (NOT in hosts.json, so they
// never ride the encrypted sync), entered once. The bundled xray turns a
// chosen node into a local SOCKS proxy that flagged SSH hosts dial through.

import { invoke } from "@tauri-apps/api/core";

// Mirrors the Rust VpnNode (serde snake_case).
export interface VpnNode {
  tag: string;
  protocol: string;
  address: string;
  port: number;
  uuid: string;
  security: string;
  flow: string;
  network: string;
  sni: string;
  fingerprint: string;
  public_key: string;
  short_id: string;
  spider_x: string;
  path: string;
  host_header: string;
  alpn: string;
}

export interface VpnProfile {
  id: string;
  name: string;
  /** Subscription URL (re-fetched on refresh). Empty if imported from raw text. */
  subUrl: string;
  nodes: VpnNode[];
  updatedAt: string; // ISO
}

const LS_KEY = "nexussh.vpnProfiles";

export function loadProfiles(): VpnProfile[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProfiles(list: VpnProfile[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

export function getProfile(id: string | null | undefined): VpnProfile | undefined {
  if (!id) return undefined;
  return loadProfiles().find((p) => p.id === id);
}

// --- backend command wrappers ---------------------------------------------

export async function vpnFetchSubscription(url: string): Promise<string> {
  return await invoke<string>("vpn_fetch_subscription", { url });
}

export async function vpnParseSubscription(subText: string): Promise<VpnNode[]> {
  return await invoke<VpnNode[]>("vpn_parse_subscription", { subText });
}

// --- profile CRUD ----------------------------------------------------------

function newId(): string {
  return "vpn-" + crypto.randomUUID();
}

/** Import a profile from a subscription URL (fetch + parse). */
export async function addProfileFromUrl(name: string, url: string): Promise<VpnProfile> {
  const text = await vpnFetchSubscription(url);
  const nodes = await vpnParseSubscription(text);
  const profile: VpnProfile = {
    id: newId(),
    name: name.trim() || url,
    subUrl: url,
    nodes,
    updatedAt: new Date().toISOString(),
  };
  saveProfiles([...loadProfiles(), profile]);
  return profile;
}

/** Import a profile from pasted raw subscription/share-link text. */
export async function addProfileFromText(name: string, text: string): Promise<VpnProfile> {
  const nodes = await vpnParseSubscription(text);
  const profile: VpnProfile = {
    id: newId(),
    name: name.trim() || "profile",
    subUrl: "",
    nodes,
    updatedAt: new Date().toISOString(),
  };
  saveProfiles([...loadProfiles(), profile]);
  return profile;
}

/** Re-fetch a URL-based profile's subscription and refresh its node list. */
export async function refreshProfile(id: string): Promise<VpnProfile | undefined> {
  const list = loadProfiles();
  const p = list.find((x) => x.id === id);
  if (!p || !p.subUrl) return p;
  const text = await vpnFetchSubscription(p.subUrl);
  p.nodes = await vpnParseSubscription(text);
  p.updatedAt = new Date().toISOString();
  saveProfiles(list);
  return p;
}

export function removeProfile(id: string) {
  saveProfiles(loadProfiles().filter((p) => p.id !== id));
}

/** Merge imported profiles into local storage, deduping by subUrl (or name
 *  when the URL is empty). Returns how many were newly added. */
export function importProfiles(incoming: VpnProfile[]): number {
  const list = loadProfiles();
  const seen = new Set(list.map((p) => p.subUrl || p.name));
  let added = 0;
  for (const p of incoming) {
    const key = p.subUrl || p.name;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ ...p, id: newId() });
    added += 1;
  }
  if (added) saveProfiles(list);
  return added;
}

/**
 * Resolve a host's chosen exit into a concrete node. `exit` is a node tag, or
 * "auto"/empty to prefer an auto-selecting node (tag contains "auto"/"Авто")
 * else the first node.
 */
export function resolveExit(profile: VpnProfile, exit?: string | null): VpnNode | undefined {
  if (!profile.nodes.length) return undefined;
  if (exit && exit !== "auto") {
    const found = profile.nodes.find((n) => n.tag === exit);
    if (found) return found;
  }
  const auto = profile.nodes.find((n) => /авто|auto/i.test(n.tag));
  return auto ?? profile.nodes[0];
}

// ─── Corporate VPN (Cisco AnyConnect / ocserv via openconnect+ocproxy) ────────
// Same local-only storage as xray profiles (never synced). The password is NEVER
// stored — it's prompted at connect time. The server cert pin is captured via a
// TOFU "trust" action (here in settings) so connect only needs the password.

export interface CorpVpnProfile {
  id: string;
  name: string;
  /** host, host:port, or https://host:port */
  server: string;
  username: string;
  /** Trusted server cert pin `pin-sha256:…` (TOFU). Empty = not yet trusted. */
  serverCert: string;
  /** AnyConnect auth group (optional). */
  authgroup: string;
}

/** Backend (serde snake_case) shape of a corp profile — password is separate. */
export interface CorpVpnBackend {
  name: string;
  server: string;
  username: string;
  server_cert: string;
  authgroup: string;
}

/** Map a stored profile to the backend shape the Rust commands expect. */
export function toCorpBackend(p: CorpVpnProfile): CorpVpnBackend {
  return {
    name: p.name,
    server: p.server,
    username: p.username,
    server_cert: p.serverCert,
    authgroup: p.authgroup,
  };
}

const LS_CORP = "nexussh.corpVpnProfiles";

export function loadCorpProfiles(): CorpVpnProfile[] {
  try {
    const raw = localStorage.getItem(LS_CORP);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCorpProfiles(list: CorpVpnProfile[]) {
  localStorage.setItem(LS_CORP, JSON.stringify(list));
}

export function getCorpProfile(id: string | null | undefined): CorpVpnProfile | undefined {
  if (!id) return undefined;
  return loadCorpProfiles().find((p) => p.id === id);
}

export function addCorpProfile(
  p: Omit<CorpVpnProfile, "id">,
): CorpVpnProfile {
  const profile: CorpVpnProfile = { ...p, id: "corp-" + crypto.randomUUID() };
  saveCorpProfiles([...loadCorpProfiles(), profile]);
  return profile;
}

export function updateCorpProfile(id: string, patch: Partial<CorpVpnProfile>) {
  const list = loadCorpProfiles();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch, id };
  saveCorpProfiles(list);
}

export function removeCorpProfile(id: string) {
  saveCorpProfiles(loadCorpProfiles().filter((p) => p.id !== id));
}

/** TOFU probe: ask the backend for the server's cert pin (to show + trust). */
export async function corpVpnProbeCert(p: CorpVpnProfile): Promise<string> {
  return await invoke<string>("corp_vpn_probe_cert", { profile: toCorpBackend(p) });
}

// ─── On-demand VPN backends (openconnect, ...) ────────────────────────────────
// Backend binaries aren't bundled — they're downloaded on first use into a
// per-user dir (verified via a sha256 manifest). `ensureVpnBackend` must be
// called before any command that runs the backend (probe / connect). A global
// <BackendProgress/> overlay listens to the "backend-progress" events it emits.

export interface BackendStatus {
  id: string;
  supported: boolean; // this platform has a build
  installed: boolean; // all files present with matching sha256
  files_total: number;
  files_present: number;
}

export async function backendStatus(id: string): Promise<BackendStatus> {
  return await invoke<BackendStatus>("backend_status", { id });
}

/** Download+verify a backend if not already present (idempotent). */
export async function ensureVpnBackend(id: string): Promise<void> {
  await invoke("backend_ensure", { id });
}

/** The backend id a given VPN profile type needs. Extend as VPN types grow. */
export const VPN_BACKEND_ID = "openconnect";
