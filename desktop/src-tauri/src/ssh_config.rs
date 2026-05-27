//! Parse the user's ~/.ssh/config and surface Host blocks to the UI for
//! one-click import as NexuSSH host records.
//!
//! Scope (deliberately small):
//!   * Host, HostName, User, Port, IdentityFile directives
//!   * skip wildcard Host blocks (`*`, `?`, multi-alias generic blocks)
//!   * skip Hosts without a HostName (can't connect to a pure alias)
//!   * everything else (ProxyJump, ForwardAgent, etc.) is ignored — they
//!     don't yet have a NexuSSH equivalent
//!
//! Comments (`# …`) and blank lines are skipped. Directive names are
//! matched case-insensitively per OpenSSH's own behaviour.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct SshConfigHost {
    /// Alias from `Host de-1` — used as the imported host's display name.
    pub alias: String,
    /// Resolved from the `HostName` directive.
    pub hostname: String,
    /// `User` directive, if any.
    pub user: Option<String>,
    /// `Port` directive, if any.
    pub port: Option<u16>,
    /// `IdentityFile` directive (string as-written; UI may expand `~`).
    pub identity_file: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SshConfigError {
    #[error("no home directory")]
    NoHome,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for SshConfigError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn home_dir() -> Option<PathBuf> {
    let h = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    h.map(PathBuf::from)
}

fn ssh_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh").join("config"))
}

fn is_wildcard(alias: &str) -> bool {
    alias.is_empty() || alias.contains('*') || alias.contains('?')
}

fn parse(text: &str) -> Vec<SshConfigHost> {
    let mut hosts: Vec<SshConfigHost> = Vec::new();
    // current in-progress block (None until we hit the first `Host` line)
    let mut current: Option<SshConfigHost> = None;

    let flush = |cur: &mut Option<SshConfigHost>, hosts: &mut Vec<SshConfigHost>| {
        if let Some(h) = cur.take() {
            if !is_wildcard(&h.alias) && !h.hostname.is_empty() {
                hosts.push(h);
            }
        }
    };

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // OpenSSH allows `key value` separated by whitespace OR `key=value`.
        let (key, value) = if let Some(idx) = line.find(|c: char| c.is_whitespace() || c == '=') {
            (
                line[..idx].to_ascii_lowercase(),
                line[idx + 1..].trim_start_matches(|c: char| c == '=' || c.is_whitespace()),
            )
        } else {
            continue;
        };
        let value = value.trim();

        match key.as_str() {
            "host" => {
                flush(&mut current, &mut hosts);
                // `Host a b c` — only the first non-wildcard alias becomes
                // the imported display name; multi-alias generic blocks are
                // skipped via the wildcard check at flush time anyway.
                let alias = value
                    .split_whitespace()
                    .find(|a| !is_wildcard(a))
                    .unwrap_or("")
                    .trim_matches('"')
                    .to_string();
                current = Some(SshConfigHost {
                    alias,
                    hostname: String::new(),
                    user: None,
                    port: None,
                    identity_file: None,
                });
            }
            "hostname" => {
                if let Some(c) = current.as_mut() {
                    c.hostname = value.trim_matches('"').to_string();
                }
            }
            "user" => {
                if let Some(c) = current.as_mut() {
                    c.user = Some(value.trim_matches('"').to_string());
                }
            }
            "port" => {
                if let Some(c) = current.as_mut() {
                    c.port = value.parse().ok();
                }
            }
            "identityfile" => {
                if let Some(c) = current.as_mut() {
                    c.identity_file = Some(value.trim_matches('"').to_string());
                }
            }
            _ => {}
        }
    }
    flush(&mut current, &mut hosts);
    hosts
}

#[tauri::command]
pub fn read_ssh_config() -> Result<Vec<SshConfigHost>, SshConfigError> {
    let Some(path) = ssh_config_path() else {
        return Err(SshConfigError::NoHome);
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)?;
    Ok(parse(&text))
}

/// Resolve a `~/...` prefix to the absolute path. Other paths pass through.
#[tauri::command]
pub fn expand_home(path: String) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = home_dir() {
            return h.join(rest).to_string_lossy().to_string();
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_block() {
        let text = r#"
Host de-1
  HostName 81.177.166.155
  User root
  Port 22
  IdentityFile ~/.ssh/de1_key
"#;
        let hosts = parse(text);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "de-1");
        assert_eq!(hosts[0].hostname, "81.177.166.155");
        assert_eq!(hosts[0].user.as_deref(), Some("root"));
        assert_eq!(hosts[0].port, Some(22));
        assert_eq!(hosts[0].identity_file.as_deref(), Some("~/.ssh/de1_key"));
    }

    #[test]
    fn skips_wildcards() {
        let text = r#"
Host *.production
  User admin
Host *
  ServerAliveInterval 60
Host real
  HostName real.com
  User u
"#;
        let hosts = parse(text);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
    }

    #[test]
    fn skips_host_without_hostname() {
        let text = "Host nothing\n  User noone\n";
        let hosts = parse(text);
        assert_eq!(hosts.len(), 0);
    }

    #[test]
    fn case_insensitive_directives() {
        let text = "HOST de-2\n  hostname 1.2.3.4\n  USER claude\n  port 2202\n";
        let hosts = parse(text);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname, "1.2.3.4");
        assert_eq!(hosts[0].user.as_deref(), Some("claude"));
        assert_eq!(hosts[0].port, Some(2202));
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let text = "# comment\n\nHost x\n  # inner comment\n  HostName x.com\n";
        let hosts = parse(text);
        assert_eq!(hosts.len(), 1);
    }
}
