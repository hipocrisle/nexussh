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

## Considered

- Hypervisor panels (Proxmox / QEMU over their APIs).
- Remote forwarding (`ssh -R`).

## Decided against

- **AppImage** — abandoned upstream for Tauri 2; `.deb` and `.rpm`
  against the system WebKit are what ship.
- **Dynamic SOCKS forwarding (`ssh -D`)** — the bundled VPN transport
  covers the same need.
- **RHEL 8 and 9** — no `webkit2gtk4.1` in base, EPEL or CRB; only the
  4.0 webkit, which Tauri 2 cannot use. EL10 works (EPEL first).
