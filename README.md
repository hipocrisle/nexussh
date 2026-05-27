# NexuSSH

> Cross-platform SSH client with custom Matrix UI, session history, and self-hosted sync.

**Designed for the AI-CLI era** — no more lost Claude Code / vim / htop output when scrolling back.

## Status

🚧 v0.0.1 — active early development. Desktop client first, mobile later.

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

## Roadmap

See `ROADMAP.md` for phase breakdown. v0.1 target: ~3-4 weeks of focused work.

## License

MIT. Take, fork, improve.
