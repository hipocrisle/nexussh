// One-time migration of plaintext host passwords out of hosts.json and into
// the encrypted vault. Old versions stored `auth:{kind:"password",password}`
// in plaintext on disk; this moves each secret into the vault and rewrites
// the host to reference it by key, so nothing sensitive stays in hosts.json.

import { listHosts, saveHost, HostRecord } from "./hosts";
import { vaultSet, hostPasswordKey } from "./vault";

/** Hosts that still carry a plaintext, non-empty saved password. */
export async function findPlaintextPasswordHosts(): Promise<HostRecord[]> {
  const all = await listHosts();
  return all.filter(
    (h) => h.auth.kind === "password" && h.auth.password.trim() !== "",
  );
}

/** Move every plaintext password into the (already-unlocked) vault and
 *  rewrite the host's auth to a vault reference. Returns how many migrated.
 *  Order is secret-first: we write to the vault before clearing the
 *  plaintext, so a crash can't lose the password. */
export async function migratePlaintextToVault(): Promise<number> {
  const hosts = await findPlaintextPasswordHosts();
  let migrated = 0;
  for (const h of hosts) {
    if (h.auth.kind !== "password") continue;
    const key = hostPasswordKey(h.id);
    await vaultSet(key, h.auth.password);
    await saveHost({ ...h, auth: { kind: "vault", key } });
    migrated += 1;
  }
  return migrated;
}
