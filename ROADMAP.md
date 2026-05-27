# NexuSSH Roadmap

## v0.1 — Desktop MVP (3-4 weeks)

### Phase 0 — Scaffold (DONE)
- [x] `desktop/` Tauri 2 + React + TS + Vite
- [x] Identifier `org.hipogas.nexussh`, product name "NexuSSH"
- [x] GitHub repo `hipocrisle/nexussh` (private)

### Phase 1 — SSH core (3-5 days)
- [ ] Install `russh` Rust crate, integrate as Tauri command
- [ ] Connect to host (password / key file / agent)
- [ ] Single terminal session, raw bytes to xterm.js
- [ ] Host record schema (id, name, host, port, user, auth_method, key_ref)
- [ ] Save host list to encrypted JSON in app data dir

### Phase 2 — UI shell (2-3 days)
- [ ] Sidebar with host list, search/filter
- [ ] Multiple terminal tabs
- [ ] Add/edit/delete host dialog
- [ ] Connection state indicators
- [ ] Connect / disconnect / reconnect actions

### Phase 3 — Matrix theme + i18n (2-3 days)
- [ ] Color palette: deep bg #0a0e0e, accent green #00ff95 / cyan #00d4ff, monospace JetBrains Mono
- [ ] Window chrome custom-titlebar
- [ ] xterm.js theme matching
- [ ] react-i18next, RU + EN translations
- [ ] Language switcher

### Phase 4 — Vault integration (1-2 days)
- [ ] Tauri command bridging our `/matrix/secrets/vault.age` CLI
- [ ] Lookup password/key by vault key path
- [ ] Optional: write-back from "save to vault" button in add-host dialog

### Phase 5 — Sync (2-3 days)
- [ ] Encrypt host config (AES-256-GCM, PBKDF2 from user master password)
- [ ] Save to user-chosen path (Syncthing folder default)
- [ ] Multi-backend: local file / Syncthing / Dropbox / Google Drive / OneDrive
  - Local file: just write to disk
  - Syncthing: write to user's Syncthing folder path
  - Cloud: Tauri http plugin to backend APIs (later — file-based at first)

### Phase 6 — Session History panel (3-5 days, KILLER FEATURE)
- [ ] Capture all bytes from SSH session (incl. alternate-buffer)
- [ ] Persist to per-session log file
- [ ] Side panel UI: scrollable text history, ANSI-rendered
- [ ] Search-in-history
- [ ] Export session as text / .ansi / .typescript
- [ ] Toggle live terminal ↔ history view

### Phase 7 — SFTP (2 days)
- [ ] File browser pane
- [ ] Upload/download
- [ ] Right-click rename/delete/chmod

### Phase 8 — Port forwarding (1-2 days)
- [ ] Local forward / Remote forward / Dynamic (SOCKS)
- [ ] UI to add and monitor active forwards

### Phase 9 — Build pipeline (1-2 days)
- [ ] Tauri 2 cross-builds
- [ ] Linux: AppImage + .deb
- [ ] macOS: .dmg (unsigned for personal — signed needs Apple Dev $99/y)
- [ ] Windows: .exe installer (unsigned for personal)
- [ ] GitHub Actions CI for release builds

### Phase 10 — Polish, testing, docs

## v0.2 — Android port (~2 weeks after v0.1)
- Capacitor wrap of React UI (shared codebase with desktop)
- Native Android Kotlin module for SSH (Capacitor plugin)
- Or: react-native-ssh-sftp wrap with React Native (separate codebase)
- Decision deferred to after v0.1 lands

## v0.3+ ideas
- AI integration: ask NexuSSH to explain a command, paste output, troubleshoot
- Snippets library (shared via sync)
- Themes marketplace
- Hypervisor management panels (Proxmox/QEMU via API) — port TabSSH approach
