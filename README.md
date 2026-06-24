<div align="center">

# 🛰️ NexuSSH

**Cross-platform SSH client built on Tauri 2.**

[![Release](https://img.shields.io/github/v/release/hipocrisle/nexussh?include_prereleases&label=release&color=2ea043)](https://github.com/hipocrisle/nexussh/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Android-444)](#-install)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://tauri.app)
[![SSH](https://img.shields.io/badge/SSH-pure%20Rust%20(russh)-dea584)](https://github.com/Eugeny/russh)

**English** · [Русский](README.ru.md)

</div>

---

A native SSH client (~15 MB, Tauri 2 + Rust) with a dark UI, an encrypted
credential vault, end-to-end encrypted sync across devices, and an optional
built-in VPN transport.

## Features

**Terminal**
- Split tabs and keyboard shortcuts
- Status line with live connection state
- Theme and font selection
- Built-in search and session history

**Connecting**
- Quick-connect by IP address
- Host-key verification (TOFU, `known_hosts.json`); SFTP verifies keys too
- Legacy algorithm support for old Cisco IOS / ESXi devices
- SFTP file browse and transfer over the same connection

**Security**
- Encrypted credential vault (age) with idle auto-lock
- Envelope-encrypted host saves, an encryptable host list, scoped filesystem access, strict CSP

**Sync**
- Cloud sync of hosts and settings, end-to-end encrypted
- Recovery key and self-healing force-resync
- Bulk import, cross-PC host export/import

**Built-in VPN transport**
- Per-host "route via built-in VPN" — reach hosts from networks where they're blocked, without a separate VPN client or admin rights
- Bundles [xray-core](https://github.com/XTLS/Xray-core); paste your own subscription (VLESS / Reality / VMess / Trojan / Shadowsocks link)
- Userspace local SOCKS (no system TUN); subscriptions stay local and are never synced

**Platform**
- Windows, Linux (`.deb` + `.rpm`), Android (signed APK)
- Self-hosted auto-updater (in-app *Install & restart*)
- Russian and English UI

## 📥 Install

From the **[releases page](https://github.com/hipocrisle/nexussh/releases/latest)**:

| OS | File | How |
|----|------|-----|
| Windows | `NexuSSH_*_x64-setup.exe` | double-click |
| Linux (Debian/Ubuntu) | `NexuSSH_*_amd64.deb` | `sudo apt install ./NexuSSH_*_amd64.deb` |
| Linux (Fedora/RHEL) | `NexuSSH_*.x86_64.rpm` | `sudo dnf install ./NexuSSH_*.x86_64.rpm` |
| Android | `NexuSSH_*.apk` | install the signed APK |

Linux builds use the system WebKit (`.deb`/`.rpm`), not AppImage. The in-app
**Install & restart** keeps it current.

## 🛠️ Build from source

```bash
git clone https://github.com/hipocrisle/nexussh.git
cd nexussh/desktop
npm install
npm run tauri dev      # dev
npm run tauri build    # installers
```

Requires Rust (stable), Node 18+, and the
[Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

## 🧱 Stack

- [Tauri 2](https://tauri.app) — Rust backend + system WebView
- React 19 + Vite + Tailwind
- [xterm.js](https://xtermjs.org) — terminal renderer
- [russh](https://github.com/Eugeny/russh) — pure-Rust SSH
- age — vault encryption
- [xray-core](https://github.com/XTLS/Xray-core) — bundled VPN transport

## 📄 License

See [LICENSE](LICENSE).
