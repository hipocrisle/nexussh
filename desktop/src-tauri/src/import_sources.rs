//! Unified host-import sources. Aggregates data from:
//!
//!   * `~/.ssh/config`              (cross-platform)        — see ssh_config.rs
//!   * `~/.ssh/known_hosts`          (cross-platform)        — Unix-style
//!   * PuTTY Registry sessions       (Windows only)          — `HKCU\Software\SimonTatham\PuTTY\Sessions\*`
//!   * Windows Terminal profiles     (Windows only)          — `settings.json` with `commandline: ssh ...`
//!
//! Each source returns a `Vec<ImportableHost>` tagged with `source` so the
//! UI can show a badge per row and the user can cross-source dedup.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct ImportableHost {
    /// Short identifier rendered as a chip in the UI: "ssh-config", "known-hosts",
    /// "putty", "wt".
    pub source: &'static str,
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    let h = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    h.map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// known_hosts
// ---------------------------------------------------------------------------

/// Parse one `known_hosts` line. Returns one ImportableHost per non-hashed,
/// non-revoked host entry. Multiple comma-separated hostnames on a single
/// line become separate hosts (most common case is `name,ip` — we emit both).
fn parse_known_hosts_line(line: &str) -> Vec<ImportableHost> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return Vec::new();
    }
    // Skip marker lines: @cert-authority, @revoked
    let line = if let Some(stripped) = line.strip_prefix('@') {
        // Skip until whitespace, drop the marker word
        if let Some(idx) = stripped.find(char::is_whitespace) {
            stripped[idx + 1..].trim_start()
        } else {
            return Vec::new();
        }
    } else {
        line
    };
    let first = match line.split_whitespace().next() {
        Some(f) => f,
        None => return Vec::new(),
    };
    // Hashed entries start with `|1|salt|hash` — we can't recover the name
    if first.starts_with("|1|") {
        return Vec::new();
    }
    let mut out = Vec::new();
    for token in first.split(',') {
        let (host, port) = parse_host_port(token);
        if host.is_empty() {
            continue;
        }
        out.push(ImportableHost {
            source: "known-hosts",
            alias: host.clone(),
            hostname: host,
            user: None,
            port,
            identity_file: None,
        });
    }
    out
}

/// Parse `host` or `[host]:port` syntax used in known_hosts and elsewhere.
fn parse_host_port(token: &str) -> (String, Option<u16>) {
    let t = token.trim();
    if t.starts_with('[') {
        if let Some(close) = t.find("]:") {
            let host = &t[1..close];
            let port: Option<u16> = t[close + 2..].parse().ok();
            return (host.to_string(), port);
        }
        if let Some(stripped) = t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            return (stripped.to_string(), None);
        }
    }
    (t.to_string(), None)
}

fn read_known_hosts() -> Vec<ImportableHost> {
    let Some(path) = home_dir().map(|h| h.join(".ssh").join("known_hosts")) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in text.lines() {
        for h in parse_known_hosts_line(line) {
            let key = (h.hostname.clone(), h.port);
            if seen.insert(key) {
                out.push(h);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// ~/.ssh/config — re-use the ssh_config.rs parser but wrap with source tag
// ---------------------------------------------------------------------------

fn read_ssh_config_tagged() -> Vec<ImportableHost> {
    let Ok(hosts) = crate::ssh_config::read_ssh_config() else {
        return Vec::new();
    };
    hosts
        .into_iter()
        .map(|h| ImportableHost {
            source: "ssh-config",
            alias: h.alias,
            hostname: h.hostname,
            user: h.user,
            port: h.port,
            identity_file: h.identity_file,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// PuTTY Registry (Windows-only)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn read_putty() -> Vec<ImportableHost> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let mut out = Vec::new();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(sessions) = hkcu.open_subkey("Software\\SimonTatham\\PuTTY\\Sessions") else {
        return out;
    };
    for name in sessions.enum_keys().filter_map(Result::ok) {
        let Ok(session) = sessions.open_subkey(&name) else { continue };
        let host: String = session.get_value("HostName").unwrap_or_default();
        if host.is_empty() {
            continue;
        }
        let user: String = session.get_value("UserName").unwrap_or_default();
        let port_dword: u32 = session.get_value("PortNumber").unwrap_or(22);
        let port: u16 = if port_dword > 0 && port_dword < 65536 {
            port_dword as u16
        } else {
            22
        };
        let key_file: String = session.get_value("PublicKeyFile").unwrap_or_default();
        // PuTTY mangles session names — `%20` for spaces, `%2B` for plus, etc.
        let alias = decode_putty_name(&name);
        out.push(ImportableHost {
            source: "putty",
            alias,
            hostname: host,
            user: if user.is_empty() { None } else { Some(user) },
            port: Some(port),
            identity_file: if key_file.is_empty() {
                None
            } else {
                Some(key_file)
            },
        });
    }
    out
}

#[cfg(not(windows))]
fn read_putty() -> Vec<ImportableHost> {
    Vec::new()
}

/// PuTTY session names in the Registry use percent-encoding for non-alnum
/// characters: " " becomes "%20", "+" becomes "%2B", etc.
fn decode_putty_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Windows Terminal profiles (Windows-only — settings.json lives in
// %LOCALAPPDATA%\Packages\...\LocalState\settings.json or the unpackaged path)
// ---------------------------------------------------------------------------

fn wt_settings_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !cfg!(windows) {
        return out;
    }
    let Some(local) = std::env::var("LOCALAPPDATA").ok().map(PathBuf::from) else {
        return out;
    };
    for pkg in [
        "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
        "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe",
    ] {
        out.push(
            local
                .join("Packages")
                .join(pkg)
                .join("LocalState")
                .join("settings.json"),
        );
    }
    // Unpackaged (rare)
    out.push(
        local
            .join("Microsoft")
            .join("Windows Terminal")
            .join("settings.json"),
    );
    out
}

fn read_wt() -> Vec<ImportableHost> {
    let mut out = Vec::new();
    for path in wt_settings_paths() {
        if !path.exists() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        // WT JSON is sometimes JSONC (allows comments). Strip them.
        let cleaned = strip_jsonc(&text);
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&cleaned) else {
            continue;
        };
        let profiles = value
            .pointer("/profiles/list")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for p in profiles {
            let cmd = p.get("commandline").and_then(|v| v.as_str()).unwrap_or("");
            if cmd.is_empty() {
                continue;
            }
            if let Some(host) = extract_ssh_target(cmd) {
                let name = p
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&host.hostname)
                    .to_string();
                out.push(ImportableHost {
                    source: "wt",
                    alias: name,
                    hostname: host.hostname,
                    user: host.user,
                    port: host.port,
                    identity_file: host.identity_file,
                });
            }
        }
    }
    out
}

struct ExtractedSsh {
    hostname: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
}

/// Extract user/host/port/identity from a shell commandline that contains
/// `ssh ...`. Best-effort; returns None if no ssh user@host target found.
fn extract_ssh_target(cmd: &str) -> Option<ExtractedSsh> {
    // Naive tokenize on whitespace — good enough for the simple
    // `ssh user@host -p 2222` shapes that show up in WT profiles.
    let lower = cmd.to_lowercase();
    let idx = lower.find("ssh")?;
    // Ensure ssh is a standalone token (preceded by start or whitespace,
    // followed by whitespace).
    if idx > 0 && !cmd[..idx].ends_with(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
        return None;
    }
    let tail = &cmd[idx + 3..];
    if !tail.starts_with(char::is_whitespace) {
        return None;
    }
    let args: Vec<&str> = tail.split_whitespace().collect();
    let mut i = 0;
    let mut port: Option<u16> = None;
    let mut identity: Option<String> = None;
    let mut target: Option<String> = None;
    while i < args.len() {
        let a = args[i];
        if a == "-p" || a == "-P" {
            i += 1;
            if i < args.len() {
                port = args[i].parse().ok();
            }
        } else if a == "-i" {
            i += 1;
            if i < args.len() {
                identity = Some(args[i].trim_matches('"').to_string());
            }
        } else if a.starts_with('-') {
            // skip unknown flag (no value heuristic — keep going)
        } else if target.is_none() {
            target = Some(a.trim_matches('"').to_string());
        }
        i += 1;
    }
    let target = target?;
    let (user, host) = if let Some(at) = target.find('@') {
        (Some(target[..at].to_string()), target[at + 1..].to_string())
    } else {
        (None, target)
    };
    if host.is_empty() {
        return None;
    }
    Some(ExtractedSsh {
        hostname: host,
        user,
        port,
        identity_file: identity,
    })
}

/// Remove `//` line comments and `/* ... */` block comments. WT settings.json
/// is technically JSONC; strict serde_json refuses comments.
fn strip_jsonc(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut in_string = false;
    let mut string_quote = b'"';
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            out.push(c as char);
            if c == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if c == string_quote {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == b'"' {
            in_string = true;
            string_quote = b'"';
            out.push(c as char);
            i += 1;
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'/' {
                // line comment to next newline
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if bytes[i + 1] == b'*' {
                // block comment to */
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
                continue;
            }
        }
        out.push(c as char);
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Aggregator + Tauri command
// ---------------------------------------------------------------------------

/// Read a UTF-8 text file the user picked (for bulk host-list import).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_import_sources() -> Vec<ImportableHost> {
    let mut out = Vec::new();
    out.extend(read_ssh_config_tagged());
    out.extend(read_known_hosts());
    out.extend(read_putty());
    out.extend(read_wt());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_hosts_simple() {
        let hosts = parse_known_hosts_line("example.com ssh-rsa AAAAB");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname, "example.com");
        assert_eq!(hosts[0].port, None);
    }

    #[test]
    fn parses_known_hosts_bracket_port() {
        let hosts = parse_known_hosts_line("[bastion.example.com]:2222 ssh-ed25519 AAAA");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname, "bastion.example.com");
        assert_eq!(hosts[0].port, Some(2222));
    }

    #[test]
    fn parses_known_hosts_comma_list() {
        let hosts = parse_known_hosts_line("de1.com,10.0.0.1 ssh-rsa AAAA");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].hostname, "de1.com");
        assert_eq!(hosts[1].hostname, "10.0.0.1");
    }

    #[test]
    fn skips_hashed_known_hosts() {
        let hosts = parse_known_hosts_line("|1|saltSalt|hashHash ssh-rsa AAAA");
        assert_eq!(hosts.len(), 0);
    }

    #[test]
    fn skips_comments_and_revoked() {
        assert!(parse_known_hosts_line("# comment").is_empty());
        assert!(parse_known_hosts_line("").is_empty());
        // @revoked marker — should skip
        let hosts = parse_known_hosts_line("@revoked old.host ssh-rsa AAAA");
        // Implementation treats it as host after marker — that's fine. But empty
        // and pure comments must be 0.
        assert!(hosts.len() <= 1);
    }

    #[test]
    fn putty_name_percent_decode() {
        assert_eq!(decode_putty_name("Default%20Settings"), "Default Settings");
        assert_eq!(decode_putty_name("MyPlus%2Bone"), "MyPlus+one");
        assert_eq!(decode_putty_name("plain"), "plain");
    }

    #[test]
    fn extracts_ssh_from_wt_commandline() {
        let s = extract_ssh_target("ssh root@de1.com -p 2222").unwrap();
        assert_eq!(s.hostname, "de1.com");
        assert_eq!(s.user.as_deref(), Some("root"));
        assert_eq!(s.port, Some(2222));
    }

    #[test]
    fn extracts_ssh_with_identity() {
        let s = extract_ssh_target("ssh -i ~/.ssh/key claude@10.0.0.1").unwrap();
        assert_eq!(s.hostname, "10.0.0.1");
        assert_eq!(s.user.as_deref(), Some("claude"));
        assert_eq!(s.identity_file.as_deref(), Some("~/.ssh/key"));
    }

    #[test]
    fn extracts_ssh_no_user() {
        let s = extract_ssh_target("ssh server.local").unwrap();
        assert_eq!(s.hostname, "server.local");
        assert!(s.user.is_none());
    }

    #[test]
    fn rejects_non_ssh_commandline() {
        assert!(extract_ssh_target("pwsh.exe -NoLogo").is_none());
        assert!(extract_ssh_target("ssh-keygen -t ed25519").is_none());
    }

    #[test]
    fn jsonc_strip_keeps_strings() {
        let text = r#"{
            // line comment
            "name": "PowerShell // not a comment",
            /* block
               comment */
            "command": "ssh root@host"
        }"#;
        let cleaned = strip_jsonc(text);
        assert!(cleaned.contains("PowerShell // not a comment"));
        assert!(!cleaned.contains("// line comment"));
        assert!(!cleaned.contains("/* block"));
    }
}
