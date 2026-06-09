// Shareable host bundle — export a chosen subtree of hosts (and optionally
// VPN profiles) into an age-passphrase-encrypted file for transfer to a
// phone or a colleague, and import one back.
//
// Passwords are NEVER exported. Usernames are stripped unless explicitly kept.
// The crypto + file I/O live in the Rust `bundle` module; this layer only
// shapes the JSON payload and merges imported hosts into the local store.

import { invoke } from "@tauri-apps/api/core";
import { HostRecord, listHosts, saveHostsBatch, newHostId } from "./hosts";
import { VpnProfile, importProfiles } from "./vpn";

export const BUNDLE_VERSION = 1;

/** A host stripped of all secrets, ready to share. */
export interface BundleHost {
  name: string;
  host: string;
  port: number;
  user?: string; // present only when "keep usernames" was chosen
  group?: string;
  note?: string;
}

export interface BundlePayload {
  version: number;
  hosts: BundleHost[];
  /** Full VPN profiles incl. subscription URL — a secret; opt-in only. */
  vpn?: VpnProfile[];
}

/** Strip a HostRecord down to its shareable fields. Passwords/keys are always
 *  dropped; the username is kept only when `keepUsers` is true. */
export function toBundleHost(h: HostRecord, keepUsers: boolean): BundleHost {
  return {
    name: h.name,
    host: h.host,
    port: h.port,
    ...(keepUsers && h.user ? { user: h.user } : {}),
    ...(h.group ? { group: h.group } : {}),
    ...(h.note ? { note: h.note } : {}),
  };
}

/** Encrypt + write the bundle to `path`. */
export async function exportBundle(
  path: string,
  passphrase: string,
  payload: BundlePayload,
): Promise<void> {
  await invoke("bundle_export", {
    path,
    passphrase,
    content: JSON.stringify(payload),
  });
}

/** Read + decrypt a bundle file, returning its parsed payload. */
export async function readBundle(
  path: string,
  passphrase: string,
): Promise<BundlePayload> {
  const json = await invoke<string>("bundle_import", { path, passphrase });
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.hosts)) {
    throw new Error("invalid bundle");
  }
  return parsed as BundlePayload;
}

/** Merge bundle hosts into the local store. Dedup by host:port (skipped).
 *  Imported hosts always land as "ask password every time" — no secrets ride
 *  the bundle. Returns counts. */
export async function importBundleHosts(
  payload: BundlePayload,
): Promise<{ added: number; skipped: number }> {
  const existing = await listHosts();
  const seen = new Set(existing.map((h) => `${h.host}:${h.port}`));
  const recs: HostRecord[] = [];
  let skipped = 0;
  for (const bh of payload.hosts) {
    // Validate untrusted bundle fields — a hostile/malformed bundle could carry
    // wrong types or out-of-range ports that would break connect later.
    const host = typeof bh.host === "string" ? bh.host.trim() : "";
    if (!host) {
      skipped += 1;
      continue;
    }
    const port =
      Number.isInteger(bh.port) && bh.port >= 1 && bh.port <= 65535
        ? bh.port
        : 22;
    const key = `${host}:${port}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const rec: HostRecord = {
      id: newHostId(),
      name: typeof bh.name === "string" && bh.name ? bh.name : host,
      host,
      port,
      // Preserve the exported login verbatim. If the bundle was exported WITHOUT
      // logins, the host stays login-less — never inject the importing user's own
      // default login into every host.
      user: typeof bh.user === "string" ? bh.user : "",
      auth: { kind: "password", password: "" },
      alwaysAskPassword: true,
      group: typeof bh.group === "string" ? bh.group : undefined,
      note: typeof bh.note === "string" ? bh.note : undefined,
    };
    recs.push(rec);
  }
  // One vault write for the whole bundle, not one per host (O(N²)).
  await saveHostsBatch(recs);
  return { added: recs.length, skipped };
}

/** Import the VPN profiles carried in a bundle (if any). Returns count added. */
export function importBundleVpn(payload: BundlePayload): number {
  if (!payload.vpn || !payload.vpn.length) return 0;
  return importProfiles(payload.vpn);
}
