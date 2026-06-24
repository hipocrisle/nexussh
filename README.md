<div align="center">

# 🛰️ NexuSSH

**A fast, native, cross-platform SSH client built for the AI-CLI era.**

*Never lose your Claude Code / vim / htop output when scrolling back again.*

[![Release](https://img.shields.io/github/v/release/hipocrisle/nexussh?include_prereleases&label=release&color=2ea043)](https://github.com/hipocrisle/nexussh/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Android-444)](#-install)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://tauri.app)
[![SSH](https://img.shields.io/badge/SSH-pure%20Rust%20(russh)-dea584)](https://github.com/Eugeny/russh)

**English** · [Русский](README.ru.md)

</div>

---

## ✨ Why NexuSSH

Termius is paywalled. Tabby is bloated Electron+Angular. NexuSSH is a **~15 MB native binary** (Tauri 2, not Electron) with a custom Matrix-style UI, end-to-end encrypted sync, an optional built-in VPN transport, and a killer feature no other client has: **it captures every byte that crosses the wire** — including alternate-screen apps like Claude Code, vim and htop — so you can scroll back, search and export your whole session.

## 🚀 Features

### Terminal & sessions
- 🖥️ **Full byte-capture Session History** — records *all* terminal output, including alternate-screen-buffer apps (Claude Code, vim, htop). Scroll back through everything, search it, export it. Encrypted at rest. *No other client does this.*
- 🗂️ **Tabs done right** — rounded tabs, split-view, restore last closed tab (`Ctrl+Shift+T`), persistent layout.
- 📊 **Status line** — live connection state at a glance.
- 🎨 **Matrix-style dark UI** — green/cyan accents, monospace, rounded window. No Material/iOS pretensions.

### Connecting
- ⚡ **Quick-connect** — type `user@host` and you're in.
- 🩺 **Host-reachability probe** — TCP-checks `host:port` *before* asking for a password (PuTTY-style), so an offline host is never mistaken for a wrong password.
- 🔑 **TOFU host-key verification** — `known_hosts.json`, MITM-safe; SFTP verifies host keys too.
- 🧩 **Legacy algorithm support** — connects to old Cisco IOS / ESXi gear that modern clients refuse.
- 📁 **SFTP** — browse and transfer files over the same connection.

### Security & secrets
- 🔐 **Encrypted vault** for credentials (age-based), with **idle auto-lock**.
- 🛡️ **Envelope-encrypted host saves**, an **encryptable host list**, scoped filesystem access and a strict CSP.

### Sync & multi-device
- ☁️ **Self-hosted account sync** — your hosts & settings across machines, end-to-end encrypted.
- 🔁 **Recovery key** + **self-healing force-resync** — never get locked out, never desync.
- 📦 **Bulk import** (100+ hosts), cross-PC export/import, transfer bundles.

### Built-in VPN transport
- 🌐 **Per-host "route via built-in VPN"** — reach SSH hosts from networks where they're blocked, **without installing a VPN client or admin rights**.
- 🧅 Bundles [xray-core](https://github.com/XTLS/Xray-core): paste **your own** subscription (any VLESS / Reality / VMess / Trojan / Shadowsocks link or `…/sub/…` URL) in **Settings → VPN**, flag a host and pick an exit. That host's connection is dialed through a local SOCKS proxy egressing via your chosen node.
- 🔒 **Userspace only** (local SOCKS, no system TUN) — looks like ordinary HTTPS, survives locked-down work machines. Subscriptions stay **local**, never written to `hosts.json` or pushed through sync.

### Platform & updates
- 🪟🐧🤖 **Windows, Linux (.deb + .rpm), Android** (signed APK).
- 🔄 **Self-hosted auto-updater** — in-app *Install & restart*, served from a self-hosted mirror (reachable from restricted networks).
- 🌍 **Bilingual UI** — Russian & English.

## 📸 Screenshots

> _Drop images into `docs/screenshots/` and they'll render here._

<div align="center">
<img src="docs/screenshots/main.png" alt="NexuSSH terminal" width="80%">
<br><em>Main terminal — Matrix-style UI</em>
<br><br>
<img src="docs/screenshots/history.png" alt="Session History" width="80%">
<br><em>Full byte-capture Session History — search &amp; export</em>
</div>

## 📥 Install

Grab the latest build from the **[releases page](https://github.com/hipocrisle/nexussh/releases/latest)**:

| OS | File | How |
|----|------|-----|
| **Windows** | `NexuSSH_*_x64-setup.exe` | double-click |
| **Linux (Debian/Ubuntu)** | `NexuSSH_*_amd64.deb` | `sudo apt install ./NexuSSH_*_amd64.deb` |
| **Linux (Fedora/RHEL)** | `NexuSSH_*.x86_64.rpm` | `sudo dnf install ./NexuSSH_*.x86_64.rpm` |
| **Android** | `NexuSSH_*.apk` | install the signed APK |

Linux builds use the system WebKit (`.deb`/`.rpm`), not AppImage — no white-screen on modern distros. The in-app **Install & restart** keeps you current.

## 🛠️ Build from source

```bash
git clone https://github.com/hipocrisle/nexussh.git
cd nexussh/desktop
npm install
npm run tauri dev      # run in dev
npm run tauri build    # produce installers
```

**Requirements:** Rust (stable), Node 18+, and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

## 🧱 Tech stack

- **[Tauri 2](https://tauri.app)** — Rust backend + system WebView (~15 MB vs Electron's ~150 MB)
- **React 19 + Vite + Tailwind** — UI
- **[xterm.js](https://xtermjs.org)** — terminal renderer with custom byte-capture
- **[russh](https://github.com/Eugeny/russh)** — pure-Rust SSH protocol
- **age** — encryption for vault & history
- **[xray-core](https://github.com/XTLS/Xray-core)** — bundled VPN transport

## 📄 License

See [LICENSE](LICENSE).

---

<div align="center">
<sub>Built with ☕ and Rust · Issues &amp; PRs welcome</sub>
</div>
