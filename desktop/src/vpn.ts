// Built-in VPN transport — client side. Profiles (a subscription URL + its
// parsed nodes) are stored locally per machine (NOT in hosts.json, so they
// never ride the encrypted sync), entered once. The bundled xray turns a
// chosen node into a local SOCKS proxy that flagged SSH hosts dial through.

import { invoke } from "@tauri-apps/api/core";
import { vaultGet, vaultSet, vaultDelete } from "./vault";

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
  /** Subscription URL (re-fetched on refresh). Empty if imported from raw text.
   *  A SECRET (carries a token) → moved to the vault; blank in the LS copy. */
  subUrl: string;
  /** Metadata flag kept in LS (the URL itself is in the vault): this profile was
   *  imported from a subscription URL, so it can be refreshed. */
  hasSubUrl?: boolean;
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

// ─── xray secrets → vault (audit F12) ─────────────────────────────────────────
// The VLESS node uuids and the subscription URL are secrets and must not sit in
// plaintext localStorage. They live in the age-vault; the LS profile keeps each
// node's uuid="" and subUrl="". The built-in VPN is single-user (the owner runs
// a vault that unlocks at app entry), so the vault coupling is fine.
interface VpnSecret {
  subUrl: string;
  uuids: Record<string, string>; // node tag → uuid
}

function vpnSecretVaultKey(id: string): string {
  return `nexussh.vpn.${id}`;
}

/** Pull the per-node uuids + subUrl for a profile out of the vault. */
async function getVpnSecret(id: string): Promise<VpnSecret> {
  try {
    const raw = await vaultGet(vpnSecretVaultKey(id));
    if (!raw) return { subUrl: "", uuids: {} };
    const p = JSON.parse(raw);
    return { subUrl: p.subUrl ?? "", uuids: p.uuids ?? {} };
  } catch {
    return { subUrl: "", uuids: {} };
  }
}

/** Write a profile's secrets (node uuids + subUrl) into the vault. */
async function putVpnSecret(id: string, profile: VpnProfile): Promise<void> {
  const uuids: Record<string, string> = {};
  for (const n of profile.nodes) if (n.uuid) uuids[n.tag] = n.uuid;
  const sec: VpnSecret = { subUrl: profile.subUrl, uuids };
  await vaultSet(vpnSecretVaultKey(id), JSON.stringify(sec));
}

/** Return a copy of a profile with node uuids + subUrl blanked (LS-safe form).
 *  Keeps a `hasSubUrl` flag so the UI still knows the profile is refreshable. */
function stripVpnSecret(profile: VpnProfile): VpnProfile {
  return {
    ...profile,
    subUrl: "",
    hasSubUrl: !!(profile.subUrl || profile.hasSubUrl),
    nodes: profile.nodes.map((n) => ({ ...n, uuid: "" })),
  };
}

/** True if a profile still carries inline secrets in LS (pre-migration). */
function hasInlineVpnSecret(p: VpnProfile): boolean {
  return !!p.subUrl || p.nodes.some((n) => !!n.uuid);
}

/** Whether a profile's secrets have been moved into the vault (for the UI badge). */
export function vpnSecretInVault(p: VpnProfile): boolean {
  return !hasInlineVpnSecret(p);
}

/** Resolve an exit node with its uuid filled from the vault (connect-time). */
export async function resolveExitWithSecret(
  profile: VpnProfile,
  exit?: string | null,
): Promise<VpnNode | undefined> {
  const node = resolveExit(profile, exit);
  if (!node) return undefined;
  if (node.uuid) return node; // legacy inline (pre-migration)
  const sec = await getVpnSecret(profile.id);
  return { ...node, uuid: sec.uuids[node.tag] ?? "" };
}

/** Move any inline xray secrets from localStorage into the vault (idempotent).
 *  No-ops silently if the vault is locked; retried on next call. */
export async function migrateVpnSecrets(): Promise<void> {
  const list = loadProfiles();
  let dirty = false;
  for (let i = 0; i < list.length; i++) {
    if (hasInlineVpnSecret(list[i])) {
      try {
        await putVpnSecret(list[i].id, list[i]);
        list[i] = stripVpnSecret(list[i]);
        dirty = true;
      } catch {
        return; // vault locked — leave inline, retry later
      }
    }
  }
  if (dirty) saveProfiles(list);
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
  await putVpnSecret(profile.id, profile); // uuids + subUrl → vault
  saveProfiles([...loadProfiles(), stripVpnSecret(profile)]);
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
  await putVpnSecret(profile.id, profile); // uuids → vault
  saveProfiles([...loadProfiles(), stripVpnSecret(profile)]);
  return profile;
}

/** Re-fetch a URL-based profile's subscription and refresh its node list. */
export async function refreshProfile(id: string): Promise<VpnProfile | undefined> {
  const list = loadProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) return undefined;
  // subUrl now lives in the vault (blanked in LS); fall back to any inline value.
  const sec = await getVpnSecret(id);
  const subUrl = p.subUrl || sec.subUrl;
  if (!subUrl) return p;
  const text = await vpnFetchSubscription(subUrl);
  const nodes = await vpnParseSubscription(text);
  const full: VpnProfile = { ...p, subUrl, nodes, updatedAt: new Date().toISOString() };
  await putVpnSecret(id, full); // refreshed uuids + subUrl → vault
  const i = list.findIndex((x) => x.id === id);
  list[i] = stripVpnSecret(full);
  saveProfiles(list);
  return full;
}

export function removeProfile(id: string) {
  saveProfiles(loadProfiles().filter((p) => p.id !== id));
  vaultDelete(vpnSecretVaultKey(id)).catch(() => {});
}

/** Merge imported profiles into local storage, deduping by subUrl (or name
 *  when the URL is empty). Returns how many were newly added. */
export async function importProfiles(incoming: VpnProfile[]): Promise<number> {
  const list = loadProfiles();
  const seen = new Set(list.map((p) => p.subUrl || p.name));
  let added = 0;
  for (const p of incoming) {
    const key = p.subUrl || p.name;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = newId();
    const full = { ...p, id };
    await putVpnSecret(id, full); // secrets → vault
    list.push(stripVpnSecret(full));
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
  /** Optional tunnel MTU override (empty = auto). Lower it (1300, then 1200) to
   *  fix SSH to MTU-picky endpoints like Cisco IOS through the tunnel. */
  mtu?: string;
}

/** Backend (serde snake_case) shape of a corp profile — password is separate. */
export interface CorpVpnBackend {
  name: string;
  server: string;
  username: string;
  server_cert: string;
  authgroup: string;
  mtu: string;
}

/** Map a stored profile to the backend shape the Rust commands expect. */
export function toCorpBackend(p: CorpVpnProfile): CorpVpnBackend {
  return {
    name: p.name,
    server: p.server,
    username: p.username,
    server_cert: p.serverCert,
    authgroup: p.authgroup,
    mtu: p.mtu ?? "",
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

/** Whether a shared corp-VPN tunnel for this profile is already up — the connect
 *  flow skips the password prompt and reuses it when so. */
export async function corpTunnelActive(p: CorpVpnProfile): Promise<boolean> {
  return await invoke<boolean>("corp_tunnel_active", { profile: toCorpBackend(p) });
}

/** Force-tear-down all active OpenConnect tunnels (manual recovery). Returns how
 *  many were killed. The next connect re-establishes and re-prompts the password. */
export async function corpVpnDisconnectAll(): Promise<number> {
  return await invoke<number>("corp_vpn_disconnect_all");
}

// ─── L2TP/IPsec (system VPN) ──────────────────────────────────────────────────
// Unlike OpenConnect (a userspace SOCKS proxy), L2TP/IPsec has no userspace
// client, so this drives the OS's native VPN stack (Windows-first). It's a SYSTEM
// tunnel: split-tunnel (NOT the default gateway), only the SSH host + any profile
// routes go through it; SSH connects directly once it's up. Shared per profile
// (ref-counted) like the OpenConnect tunnel.

export interface L2tpProfile {
  id: string;
  name: string;
  /** host or IP */
  server: string;
  username: string;
  /** IPsec pre-shared key. */
  psk: string;
  /** Require encryption (-EncryptionLevel Required). */
  requireEncryption: boolean;
  /** Extra split-tunnel routes (CIDRs) beyond the auto host route. */
  routes?: string[];
}

/** Backend (serde snake_case) shape — PPP password is separate. */
export interface L2tpBackend {
  name: string;
  server: string;
  username: string;
  psk: string;
  require_encryption: boolean;
  routes: string[];
}

export function toL2tpBackend(p: L2tpProfile): L2tpBackend {
  return {
    name: p.name,
    server: p.server,
    username: p.username,
    psk: p.psk,
    require_encryption: p.requireEncryption,
    routes: (p.routes ?? []).filter((r) => r.trim() !== ""),
  };
}

// The IPsec PSK is a secret and must NOT sit in plaintext localStorage (audit
// F11/F29). It lives in the age-vault under this key; the LS profile keeps psk="".
// The built-in VPN is single-user (the owner) and they run a vault, so the
// coupling to an unlocked vault is acceptable.
function l2tpPskVaultKey(id: string): string {
  return `nexussh.l2tp.${id}.psk`;
}

/** Read a profile's PSK: prefer the vault; fall back to a not-yet-migrated inline
 *  value so legacy profiles keep working until migrateL2tpSecrets() moves them. */
export async function getL2tpPsk(p: L2tpProfile): Promise<string> {
  if (p.psk) return p.psk; // legacy inline (pre-migration)
  try {
    return await vaultGet(l2tpPskVaultKey(p.id));
  } catch {
    return "";
  }
}

/** Backend shape with the PSK resolved from the vault. Use at connect time. */
export async function toL2tpBackendWithSecret(p: L2tpProfile): Promise<L2tpBackend> {
  return { ...toL2tpBackend(p), psk: await getL2tpPsk(p) };
}

/** Move any inline PSKs from localStorage into the vault (one-time, idempotent).
 *  Silently no-ops if the vault is locked/unavailable — retried on next call. */
export async function migrateL2tpSecrets(): Promise<void> {
  const list = loadL2tpProfiles();
  let dirty = false;
  for (const p of list) {
    if (p.psk) {
      try {
        await vaultSet(l2tpPskVaultKey(p.id), p.psk);
        p.psk = "";
        dirty = true;
      } catch {
        return; // vault locked — leave inline for now, try again later
      }
    }
  }
  if (dirty) saveL2tpProfiles(list);
}

const LS_L2TP = "nexussh.l2tpProfiles";

export function loadL2tpProfiles(): L2tpProfile[] {
  try {
    const raw = localStorage.getItem(LS_L2TP);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveL2tpProfiles(list: L2tpProfile[]) {
  localStorage.setItem(LS_L2TP, JSON.stringify(list));
}

export function getL2tpProfile(id: string | null | undefined): L2tpProfile | undefined {
  if (!id) return undefined;
  return loadL2tpProfiles().find((p) => p.id === id);
}

export async function addL2tpProfile(p: Omit<L2tpProfile, "id">): Promise<L2tpProfile> {
  const id = "l2tp-" + crypto.randomUUID();
  // PSK → vault, never plaintext LS.
  await vaultSet(l2tpPskVaultKey(id), p.psk ?? "");
  const profile: L2tpProfile = { ...p, psk: "", id };
  saveL2tpProfiles([...loadL2tpProfiles(), profile]);
  return profile;
}

export async function updateL2tpProfile(id: string, patch: Partial<L2tpProfile>) {
  const list = loadL2tpProfiles();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return;
  const next = { ...list[i], ...patch, id };
  if (patch.psk !== undefined) {
    await vaultSet(l2tpPskVaultKey(id), patch.psk); // secret → vault
    next.psk = ""; // never persist the PSK in LS
  }
  list[i] = next;
  saveL2tpProfiles(list);
}

export async function removeL2tpProfile(id: string) {
  saveL2tpProfiles(loadL2tpProfiles().filter((p) => p.id !== id));
  try {
    await vaultDelete(l2tpPskVaultKey(id));
  } catch {
    /* vault locked / key absent — best effort */
  }
}

/** Whether a system L2TP VPN for this (resolved-with-secret) profile is already
 *  up (skip password + reuse). */
export async function l2tpActive(backend: L2tpBackend): Promise<boolean> {
  return await invoke<boolean>("l2tp_active", { profile: backend });
}

/** Force-disconnect all system L2TP VPNs (manual recovery). Returns how many. */
export async function l2tpDisconnectAll(): Promise<number> {
  return await invoke<number>("l2tp_disconnect_all");
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
