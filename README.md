# NexuSSH

> Cross-platform SSH client with custom Matrix UI, session history, and self-hosted sync.

**Designed for the AI-CLI era** — no more lost Claude Code / vim / htop output when scrolling back.

## Status

🚧 v0.0.1 — active early development. Desktop client first, mobile later.

## Install

Download from the [latest release](https://github.com/hipocrisle/nexussh/releases/latest) and run it:

- **Windows** — `NexuSSH_*_x64-setup.exe` — double-click.
- **Linux (any distro)** — `NexuSSH_*_amd64.AppImage` — right-click → Properties →
  *Allow executing as program*, then double-click. No install, no dependencies
  (the runtime is self-contained, so it works without `libfuse2`).

One file per OS, nothing else to set up. The in-app **"Install and restart"**
keeps it current, in place.

## Why

Termius is paywalled. Tabby is bloated Electron+Angular. We want:

- **Native feel**, small binary (Tauri 2 = ~15MB vs Electron 150MB)
- **Matrix-style dark UI** with green/cyan accents, monospace, no Material/iOS pretensions
- **Self-hosted sync** — Syncthing default. Google Drive / Dropbox / OneDrive as alternatives for colleagues.
- **Russian + English** UI
- **Session History panel** — capture ALL terminal bytes including alternate-screen-buffer output (Claude Code, vim, htop). Scroll back through every byte that crossed the wire, search, export. No other client has this.
- **Vault integration** with our `secrets_vault.age` for credentials

## Stack

- **Tauri 2.x** (Rust backend + WebView)
- **React + Vite + Tailwind** (UI)
- **xterm.js** (terminal renderer with custom byte-capture)
- **russh** (pure Rust SSH protocol)

## Built-in VPN transport

Reach SSH hosts from networks where the box is blocked or filtered — **without
installing a VPN client or needing admin rights**.

NexuSSH bundles [xray-core](https://github.com/XTLS/Xray-core). Paste **your own
subscription** (any standard VLESS / Reality / VMess / Trojan / Shadowsocks link
or `…/sub/…` URL) in **Settings → VPN**, then flag any host with **"route via
built-in VPN"** and pick an exit. That host's SSH connection is dialed through a
local SOCKS proxy that egresses via your chosen node.

- **Userspace only** — a local SOCKS proxy, not a system TUN. No admin rights,
  no OS network changes; only NexuSSH's own traffic is routed and it looks like
  ordinary outbound HTTPS, so it survives locked-down work machines.
- **Bring your own** — works with any provider's subscription; nothing to set up
  server-side (the subscription is access to a VPN that already exists).
- **Local & private** — subscriptions are stored per-machine, never written to
  `hosts.json` or pushed through sync.

## Roadmap

See `ROADMAP.md` for phase breakdown.

## License

MIT. Take, fork, improve.
