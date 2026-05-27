//! Session history — записываем КАЖДЫЙ байт каждой SSH-сессии на диск,
//! плюс команды для UI (list/read/search/delete/export).
//!
//! Зачем: Claude Code / vim / htop используют alternate-screen-buffer.
//! Когда они закрываются, alt-buffer контент пропадает из xterm.js scrollback
//! и пользователь не может прокрутить вверх. Мы пишем raw-байты в файл
//! независимо от того что делает терминал, а UI показывает ANSI-stripped
//! текст для чтения.
//!
//! Layout на диске:
//!   <app_data>/sessions/<session-id>.log   — raw bytes
//!   <app_data>/sessions/<session-id>.json  — { session_id, host, port, user,
//!                                              started_at, ended_at, byte_count }

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const SESSIONS_DIR: &str = "sessions";

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session not found")]
    NotFound,
    #[error("other: {0}")]
    Other(String),
}

impl serde::Serialize for HistoryError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub byte_count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub byte_count: u64,
    pub still_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub session_id: String,
    pub host: String,
    pub started_at: String,
    pub line: String,
}

fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // ISO-ish without chrono dep: @1716800000s
    format!("@{}s", secs)
}

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, HistoryError> {
    let mut p = app
        .path()
        .app_data_dir()
        .map_err(|e| HistoryError::Other(e.to_string()))?;
    p.push(SESSIONS_DIR);
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

/// One open log file + meta sidecar.
/// `ssh.rs` owns an `Arc<SessionLogger>` per session and calls `append`
/// on every chunk of bytes from the server, then `finalize` on close.
pub struct SessionLogger {
    file: Mutex<File>,
    meta_path: PathBuf,
    meta: Mutex<SessionMeta>,
}

impl SessionLogger {
    pub fn open(
        app: &AppHandle,
        session_id: &str,
        host: &str,
        port: u16,
        user: &str,
    ) -> Result<Self, HistoryError> {
        let dir = sessions_dir(app)?;
        let log_path = dir.join(format!("{}.log", session_id));
        let meta_path = dir.join(format!("{}.json", session_id));
        let file = OpenOptions::new().create(true).append(true).open(&log_path)?;
        let meta = SessionMeta {
            session_id: session_id.into(),
            host: host.into(),
            port,
            user: user.into(),
            started_at: iso_now(),
            ended_at: None,
            byte_count: 0,
        };
        std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta)?)?;
        Ok(Self {
            file: Mutex::new(file),
            meta_path,
            meta: Mutex::new(meta),
        })
    }

    pub fn append(&self, data: &[u8]) {
        if let Ok(mut f) = self.file.lock() {
            let _ = f.write_all(data);
        }
        if let Ok(mut m) = self.meta.lock() {
            m.byte_count += data.len() as u64;
        }
    }

    /// Update meta with end timestamp + final byte count and sync to disk.
    pub fn finalize(&self) {
        if let Ok(mut m) = self.meta.lock() {
            m.ended_at = Some(iso_now());
            if let Ok(bytes) = serde_json::to_vec_pretty(&*m) {
                let _ = std::fs::write(&self.meta_path, bytes);
            }
        }
        if let Ok(f) = self.file.lock() {
            let _ = f.sync_all();
        }
    }
}

#[tauri::command]
pub async fn history_list(app: AppHandle) -> Result<Vec<HistoryEntry>, HistoryError> {
    let dir = sessions_dir(&app)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(meta) = serde_json::from_slice::<SessionMeta>(&bytes) else { continue };
        let still_active = meta.ended_at.is_none();
        entries.push(HistoryEntry {
            session_id: meta.session_id,
            host: meta.host,
            port: meta.port,
            user: meta.user,
            started_at: meta.started_at,
            ended_at: meta.ended_at,
            byte_count: meta.byte_count,
            still_active,
        });
    }
    // Latest first
    entries.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(entries)
}

#[tauri::command]
pub async fn history_read(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<u8>, HistoryError> {
    let dir = sessions_dir(&app)?;
    let path = dir.join(format!("{}.log", session_id));
    if !path.exists() {
        return Err(HistoryError::NotFound);
    }
    Ok(std::fs::read(&path)?)
}

#[tauri::command]
pub async fn history_delete(
    app: AppHandle,
    session_id: String,
) -> Result<(), HistoryError> {
    let dir = sessions_dir(&app)?;
    let log = dir.join(format!("{}.log", session_id));
    let meta = dir.join(format!("{}.json", session_id));
    if log.exists() {
        std::fs::remove_file(&log)?;
    }
    if meta.exists() {
        std::fs::remove_file(&meta)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn history_search(
    app: AppHandle,
    query: String,
) -> Result<Vec<SearchHit>, HistoryError> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let dir = sessions_dir(&app)?;
    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let meta_path = dir.join(format!("{}.json", stem));
        let meta: Option<SessionMeta> = std::fs::read(&meta_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        let (host, started_at) = meta
            .map(|m| (m.host, m.started_at))
            .unwrap_or_else(|| (String::new(), String::new()));

        let Ok(bytes) = std::fs::read(&path) else { continue };
        let stripped = strip_ansi(&bytes);
        let text = String::from_utf8_lossy(&stripped);
        for line in text.lines() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    session_id: stem.clone(),
                    host: host.clone(),
                    started_at: started_at.clone(),
                    line: line.chars().take(200).collect(),
                });
                if hits.len() >= 500 {
                    return Ok(hits);
                }
            }
        }
    }
    hits.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(hits)
}

#[tauri::command]
pub async fn history_export(
    app: AppHandle,
    session_id: String,
    out_path: String,
    strip: bool,
) -> Result<(), HistoryError> {
    let dir = sessions_dir(&app)?;
    let log = dir.join(format!("{}.log", session_id));
    if !log.exists() {
        return Err(HistoryError::NotFound);
    }
    let bytes = std::fs::read(&log)?;
    let out_bytes = if strip { strip_ansi(&bytes) } else { bytes };
    std::fs::write(out_path, out_bytes)?;
    Ok(())
}

/// Strip ANSI/VT escape sequences, keep printable text + newlines.
/// Handles: CSI (`ESC [ ... letter`), OSC (`ESC ] ... BEL or ESC \`),
/// SS2/SS3/single-char ESC sequences, control chars except \n \r \t.
pub(crate) fn strip_ansi(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let c = data[i];
        if c == 0x1b {
            // ESC sequence
            if i + 1 >= data.len() {
                i += 1;
                continue;
            }
            let next = data[i + 1];
            match next {
                b'[' => {
                    // CSI — skip until final byte (0x40..=0x7e)
                    i += 2;
                    while i < data.len() {
                        let b = data[i];
                        i += 1;
                        if (0x40..=0x7e).contains(&b) {
                            break;
                        }
                    }
                }
                b']' => {
                    // OSC — skip until BEL or ESC \
                    i += 2;
                    while i < data.len() {
                        if data[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                b'P' | b'X' | b'^' | b'_' => {
                    // DCS / SOS / PM / APC — skip until ESC \ or BEL
                    i += 2;
                    while i < data.len() {
                        if data[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => {
                    // Two-char ESC sequence (e.g. ESC =, ESC >, ESC c)
                    i += 2;
                }
            }
            continue;
        }
        // Keep printable + newlines + tabs + backspace; drop other control chars
        if c == b'\n' || c == b'\r' || c == b'\t' || c >= 0x20 {
            out.push(c);
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(bytes: &[u8]) -> String {
        String::from_utf8_lossy(&strip_ansi(bytes)).to_string()
    }

    #[test]
    fn plain_text_untouched() {
        assert_eq!(s(b"hello world\n"), "hello world\n");
        assert_eq!(s(b"line1\nline2\r\n"), "line1\nline2\r\n");
        assert_eq!(s(b"\ttabbed"), "\ttabbed");
    }

    #[test]
    fn csi_sgr_color_stripped() {
        // Red "hello" reset
        assert_eq!(s(b"\x1b[31mhello\x1b[0m"), "hello");
        // Bold + color compound
        assert_eq!(s(b"\x1b[1;33mWARN\x1b[m done"), "WARN done");
    }

    #[test]
    fn csi_cursor_movement_stripped() {
        assert_eq!(s(b"abc\x1b[2Jdef"), "abcdef");
        assert_eq!(s(b"\x1b[H\x1b[J$ ls"), "$ ls");
        // CUP with two params
        assert_eq!(s(b"\x1b[10;20Htop"), "top");
    }

    #[test]
    fn alt_screen_buffer_toggle_stripped() {
        // ESC[?1049h enter alt buffer / ESC[?1049l leave — classic Claude Code
        let claude_like = b"\x1b[?1049h\x1b[H\x1b[2JClaude is thinking...\x1b[?1049l$ ";
        assert_eq!(s(claude_like), "Claude is thinking...$ ");
    }

    #[test]
    fn osc_window_title_stripped() {
        // OSC 0 ; title BEL
        assert_eq!(s(b"\x1b]0;my title\x07prompt$ "), "prompt$ ");
        // OSC with ESC \ terminator
        assert_eq!(s(b"\x1b]2;another\x1b\\rest"), "rest");
    }

    #[test]
    fn dcs_apc_stripped() {
        // DCS body ST
        assert_eq!(s(b"before\x1bPsixel-data\x1b\\after"), "beforeafter");
        // APC
        assert_eq!(s(b"x\x1b_secret\x07y"), "xy");
    }

    #[test]
    fn truncated_escape_sequences_safe() {
        // Lone ESC at end
        assert_eq!(s(b"hello\x1b"), "hello");
        // CSI without final byte
        assert_eq!(s(b"hello\x1b[31"), "hello");
        // OSC without terminator — consumes rest
        assert_eq!(s(b"hello\x1b]0;forever"), "hello");
    }

    #[test]
    fn control_chars_dropped_except_whitespace() {
        // Bell, NUL, etc. dropped; \n \r \t kept
        assert_eq!(s(b"a\x00b\x07c\nd"), "abc\nd");
    }

    #[test]
    fn two_char_esc_sequences() {
        // ESC c (RIS), ESC = (DECKPAM), ESC D (IND)
        assert_eq!(s(b"\x1bcboot\x1b=mode"), "bootmode");
    }

    #[test]
    fn large_input_perf_sanity() {
        let big: Vec<u8> = (0..100_000).map(|i| (i % 128) as u8).collect();
        let out = strip_ansi(&big);
        // Should not panic, should be smaller (control chars dropped)
        assert!(!out.is_empty());
        assert!(out.len() <= big.len());
    }
}

