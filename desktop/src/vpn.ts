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
