# NexuSSH Roadmap

Current release: **3.1.0** (stable). The beta channel must always be
numbered above stable, so the next beta is `3.2.0-beta.1`.

## Shipped

**Core** — SSH over [russh](https://github.com/Eugeny/russh) (pure Rust),
tabs and splits, keyboard-interactive and MFA, legacy algorithms for old
Cisco IOS / ESXi, host-key verification (TOFU, prompts on first use and
on change), SFTP over the same connection, local port forwarding
(`ssh -L`) with saved per-host forwards.

**Local shell** (3.1.0) — this machine's shell in a tab, plain or
elevated on Windows, with the same snippets, history and tabs as a
remote session.

**Security** — age-encrypted credential vault with idle auto-lock,
envelope-encrypted host saves, encryptable host list, strict CSP. All
findings of the 2026-07 security audit are closed.

**Sync** — end-to-end encrypted cloud sync of hosts, snippets and
settings; recovery key; bulk import and cross-machine export.

**Transport** — per-host routing through the bundled
[xray-core](https://github.com/XTLS/Xray-core) (userspace SOCKS, no TUN,
no admin rights), corporate VPN via openconnect/ocproxy, and system L2TP
profiles.

**Interface** — command palette, snippet grid with hotkeys, encrypted
session history with search, themes and fonts, Russian and English UI.

**AI assistant** — plain-language command suggestions (inserted, never
auto-run) and explanations of on-screen output, with client-side
redaction of secrets.

**Platforms and delivery** — Windows, Linux (`.deb` + `.rpm`, system
WebKit), Android (signed APK); self-hosted updater with stable and beta
channels.

## Next

- [ ] **macOS build** — the only desktop platform still missing;
      unsigned build first, signing needs an Apple developer account.
- [ ] **Telnet and RDP** entries in the new-tab menu, next to SSH, SFTP
      and the local terminal.
- [ ] Trim the startup diagnostics of the local terminal once the
      feature settles (log and shell banner are there while it is new).

## Virtual machine management

A panel for running virtual machines next to the terminal: inventory,
power, snapshots and a graphical console in a tab. Driven by the
hypervisor's own API, not by shell commands — the point is a real
management surface, not a wrapper over `qm` and `vim-cmd`.

Scope per host:

- inventory: machines, state, assigned CPU/RAM/disk, guest address;
- power: start, shutdown, reset, suspend, with the state reflected live;
- snapshots: list, create, roll back, delete;
- console: graphical, in a tab beside terminals;
- credentials in the vault like everything else, never in the host list.

Staged, because each backend is its own protocol:

- [ ] **Proxmox** — REST with API tokens; console over their proxy
      (`vncproxy` / `termproxy`) rendered by noVNC. The cheapest start
      and the full feature set in one place.
- [ ] **vCenter** — vSphere Automation REST: session auth, then
      inventory, power and snapshots map closely onto the Proxmox work.
- [ ] **VMware console** — WebMKS. Needs their HTML5 SDK, which pulls
      external JavaScript and does not fit the strict CSP the app runs
      under; decide between hosting the SDK in-bundle or leaving the
      console to the browser for this backend.
- [ ] **ESXi without vCenter** — SOAP (vim25) only; no usable Rust
      client exists, so this is hand-written XML. Last, and only if the
      earlier stages prove the panel is worth it.

This is a large piece of work — closer to a second product inside the
client than to a feature. Sequencing matters: Proxmox end to end first,
including the console, so the shape of the panel is settled before a
second backend is added.

## Considered

- Remote forwarding (`ssh -R`).

## Decided against

- **AppImage** — abandoned upstream for Tauri 2; `.deb` and `.rpm`
  against the system WebKit are what ship.
- **Dynamic SOCKS forwarding (`ssh -D`)** — the bundled VPN transport
  covers the same need.
- **RHEL 8 and 9** — no `webkit2gtk4.1` in base, EPEL or CRB; only the
  4.0 webkit, which Tauri 2 cannot use. EL10 works (EPEL first).
