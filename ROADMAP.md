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
WebKit), macOS (universal `.dmg`, ad-hoc signed), Android (signed APK);
self-hosted updater with stable and beta channels, in-app updates on
every desktop platform.

## Next

- [ ] **Apple Developer ID + notarisation** for macOS, so the app opens
      on a double click. Without it the build is ad-hoc signed and the
      first launch has to be allowed once in Privacy & Security; updates
      afterwards are unaffected. Costs $99/year.
- [ ] **Telnet** entry in the new-tab menu, next to SSH, SFTP and the
      local terminal (the serial console joins them as a module).
- [ ] Trim the startup diagnostics of the local terminal once the
      feature settles (log and shell banner are there while it is new).

## Modules

Everything beyond SSH arrives as a **module**: a panel that is off by
default, switched on per taste, with its interface loaded only when
opened. Someone who wants a plain SSH client never sees the rest.

Why inside this app and not a second one: the terminal, vault, sync,
history, snippets, updater and four-platform build are shared, and a
separate repository would mean maintaining two copies of all of it. If a
genuinely slimmer edition is ever needed, that is a build flag, not a
second project.

Modules are compiled in and toggled, not loaded from disk as plugins:
third-party plugins would need signing, a stable interface and would run
with the app's full rights — complexity that buys nothing here.

### Serial console

Connect to hardware over a COM/tty port — the usual first step when
configuring switches and routers before they have an address. Same
terminal, same snippets and history; only the transport differs. Port
picker, speed and framing, reconnect when the adapter is re-plugged.

Small and self-contained, so it doubles as the first test of the module
mechanics.

### VNC

Remote desktop over RFB: the protocol is simple and well-documented, and
a session fits the existing tab model.

### Virtual machine management

A panel for running machines: inventory with state and resources, power
(start, shutdown, reset, suspend) reflected live, snapshots (list,
create, roll back, delete), and a graphical console in a tab. Driven by
the hypervisor's API, not by shell commands — the point is real
management, not a wrapper over `qm` and `vim-cmd`. Credentials live in
the vault, never in the host list.

- [ ] **vCenter** — vSphere Automation REST: session auth, then
      inventory, power and snapshots. First, because it is the
      hypervisor we can actually test against.
- [ ] **VMware console** — WebMKS needs their HTML5 SDK, which pulls
      external JavaScript and does not fit the app's strict CSP. Decide
      between bundling the SDK and leaving this console to the browser.
- [ ] **Proxmox** — REST with API tokens, console over their proxy and
      noVNC. Deferred: no instance to test on. Technically the simplest
      of the three.
- [ ] **ESXi without vCenter** — SOAP (vim25) only, no usable Rust
      client, hand-written XML. Last, and only if the panel proves
      worthwhile.

Each backend is its own protocol, so they land one at a time, the first
one end to end, console included, before the next is started.

### Not planned

RDP in our own code is a product of its own; it would mean embedding an
existing engine, with its licence and its build on four platforms. Not
promised until there is a reason.

## Considered

- Remote forwarding (`ssh -R`).

## Decided against

- **AppImage** — abandoned upstream for Tauri 2; `.deb` and `.rpm`
  against the system WebKit are what ship.
- **Dynamic SOCKS forwarding (`ssh -D`)** — the bundled VPN transport
  covers the same need.
- **RHEL 8 and 9** — no `webkit2gtk4.1` in base, EPEL or CRB; only the
  4.0 webkit, which Tauri 2 cannot use. EL10 works (EPEL first).
