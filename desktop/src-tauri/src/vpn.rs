//! Built-in VPN transport — parse subscription share-links into nodes and
//! generate xray outbound/config JSON. SSH connections flagged "via built-in
//! VPN" are dialed through a local xray SOCKS inbound (userspace, no TUN/admin)
//! whose outbound is one of these nodes.
//!
//! This module is pure parsing + config generation (no network): the
//! subscription is fetched in the frontend and the raw text handed here, so it
//! stays dependency-free and unit-testable. We start with VLESS
//! (Reality / Vision / WS / gRPC / TLS) — the dispatch in `parse_share_link`
//! is the extension point for vmess/trojan/ss later.

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpnNode {
    /// Display name (from the #fragment), e.g. "🇫🇷 Франция".
    pub tag: String,
    /// Protocol — currently always "vless".
    pub protocol: String,
    pub address: String,
    pub port: u16,
    pub uuid: String,
    /// "reality" | "tls" | "none"
    pub security: String,
    /// "xtls-rprx-vision" | ""
    pub flow: String,
    /// "tcp" | "ws" | "grpc"
    pub network: String,
    pub sni: String,
    /// TLS fingerprint to mimic ("chrome", "firefox", ...).
    pub fingerprint: String,
    /// Reality public key (pbk).
    pub public_key: String,
    /// Reality short id (sid).
    pub short_id: String,
    /// Reality spiderX (spx).
    pub spider_x: String,
    /// ws/grpc path or grpc serviceName.
    pub path: String,
    /// ws Host header.
    pub host_header: String,
    pub alpn: String,
}

/// Decode %XX escapes (leave everything else as-is). Share-links use %20 for
/// spaces in fragments/params, so this is enough; we deliberately do NOT treat
/// '+' as space (that's form-encoding, not URI fragments).
fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Try the common base64 variants subscriptions use. Returns the decoded text
/// if it looks like share-links, otherwise the input unchanged (some providers
/// serve a plain newline list).
fn maybe_b64_decode(text: &str) -> String {
    let trimmed: String = text.split_whitespace().collect();
    let engines = [
        &general_purpose::STANDARD,
        &general_purpose::STANDARD_NO_PAD,
        &general_purpose::URL_SAFE,
        &general_purpose::URL_SAFE_NO_PAD,
    ];
    for eng in engines {
        if let Ok(bytes) = eng.decode(trimmed.as_bytes()) {
            if let Ok(s) = String::from_utf8(bytes) {
                if s.contains("://") {
                    return s;
                }
            }
        }
    }
    text.to_string()
}

/// Parse a whole subscription body (base64 or plain) into nodes.
pub fn parse_subscription(text: &str) -> Vec<VpnNode> {
    let body = maybe_b64_decode(text);
    body.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(parse_share_link)
        .collect()
}

/// Parse a single share-link. Dispatch point for future protocols.
pub fn parse_share_link(line: &str) -> Option<VpnNode> {
    if let Some(rest) = line.strip_prefix("vless://") {
        parse_vless(rest)
    } else {
        // vmess:// / trojan:// / ss:// — TODO, return None for now (callers
        // simply skip unsupported entries rather than showing a dead option).
        None
    }
}

/// Parse `UUID@HOST:PORT?query#tag`.
fn parse_vless(rest: &str) -> Option<VpnNode> {
    let (main, frag) = match rest.split_once('#') {
        Some((m, f)) => (m, pct_decode(f)),
        None => (rest, String::new()),
    };
    let (uuid, hostq) = main.split_once('@')?;
    let (hostport, query) = match hostq.split_once('?') {
        Some((hp, q)) => (hp, q),
        None => (hostq, ""),
    };
    // host:port — handle a bracketed IPv6 literal, else split on last ':'.
    let (host, port_str) = if hostport.starts_with('[') {
        let rb = hostport.find(']')?;
        let h = &hostport[1..rb];
        let p = hostport[rb + 1..].strip_prefix(':').unwrap_or("");
        (h, p)
    } else {
        let i = hostport.rfind(':')?;
        (&hostport[..i], &hostport[i + 1..])
    };
    let port: u16 = port_str.parse().ok()?;

    let mut q = std::collections::HashMap::new();
    for kv in query.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            q.insert(k.to_string(), pct_decode(v));
        }
    }
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();

    Some(VpnNode {
        tag: if frag.is_empty() { host.to_string() } else { frag },
        protocol: "vless".into(),
        address: host.to_string(),
        port,
        uuid: uuid.to_string(),
        security: {
            let s = get("security");
            if s.is_empty() { "none".into() } else { s }
        },
        flow: get("flow"),
        network: {
            let n = get("type");
            if n.is_empty() { "tcp".into() } else { n }
        },
        sni: q.get("sni").or_else(|| q.get("peer")).cloned().unwrap_or_default(),
        fingerprint: get("fp"),
        public_key: get("pbk"),
        short_id: get("sid"),
        spider_x: get("spx"),
        path: get("path"),
        host_header: q.get("host").cloned().unwrap_or_default(),
        alpn: get("alpn"),
    })
}

/// Build an xray VLESS outbound object for this node.
pub fn xray_outbound(node: &VpnNode, tag: &str) -> Value {
    let mut user = json!({ "id": node.uuid, "encryption": "none" });
    if !node.flow.is_empty() {
        user["flow"] = json!(node.flow);
    }

    let mut stream = json!({
        "network": node.network,
        "security": node.security,
    });

    match node.security.as_str() {
        "reality" => {
            stream["realitySettings"] = json!({
                "serverName": node.sni,
                "fingerprint": if node.fingerprint.is_empty() { "chrome".into() } else { node.fingerprint.clone() },
                "publicKey": node.public_key,
                "shortId": node.short_id,
                "spiderX": node.spider_x,
            });
        }
        "tls" => {
            let mut tls = json!({
                "serverName": node.sni,
                "fingerprint": if node.fingerprint.is_empty() { "chrome".into() } else { node.fingerprint.clone() },
            });
            if !node.alpn.is_empty() {
                tls["alpn"] = json!(node.alpn.split(',').collect::<Vec<_>>());
            }
            stream["tlsSettings"] = tls;
        }
        _ => {}
    }

    match node.network.as_str() {
        "ws" => {
            let mut headers = json!({});
            if !node.host_header.is_empty() {
                headers["Host"] = json!(node.host_header);
            }
            stream["wsSettings"] = json!({
                "path": if node.path.is_empty() { "/".into() } else { node.path.clone() },
                "headers": headers,
            });
        }
        "grpc" => {
            stream["grpcSettings"] = json!({ "serviceName": node.path });
        }
        _ => {}
    }

    json!({
        "tag": tag,
        "protocol": "vless",
        "settings": {
            "vnext": [ {
                "address": node.address,
                "port": node.port,
                "users": [ user ],
            } ]
        },
        "streamSettings": stream,
    })
}

/// Full xray config: a SOCKS5 inbound on 127.0.0.1:`socks_port` whose traffic
/// egresses through `node`. This is what the bundled xray sidecar runs.
pub fn xray_config(node: &VpnNode, socks_port: u16) -> Value {
    json!({
        "log": { "loglevel": "warning" },
        "inbounds": [ {
            "tag": "socks-in",
            "listen": "127.0.0.1",
            "port": socks_port,
            "protocol": "socks",
            "settings": { "udp": true, "auth": "noauth" },
        } ],
        "outbounds": [ xray_outbound(node, "proxy") ],
    })
}

/// Path to the bundled xray sidecar — Tauri places externalBin next to the app
/// executable (the target-triple suffix is stripped at bundle time).
fn xray_bin_path() -> std::path::PathBuf {
    let mut p = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    p.push(if cfg!(windows) { "xray.exe" } else { "xray" });
    p
}

/// Write the generated config to a temp file and spawn the bundled xray bound to
/// a local SOCKS port. The returned Child has kill_on_drop so the proxy dies
/// with the owning SSH session. Userspace only — no TUN, no elevation.
pub fn spawn_xray(node: &VpnNode, socks_port: u16) -> std::io::Result<tokio::process::Child> {
    use std::io::Write;
    let cfg = xray_config(node, socks_port);
    let bytes = serde_json::to_vec(&cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let path = std::env::temp_dir().join(format!("nexussh-xray-{socks_port}.json"));
    std::fs::File::create(&path)?.write_all(&bytes)?;
    tokio::process::Command::new(xray_bin_path())
        .arg("run")
        .arg("-c")
        .arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
}

#[tauri::command]
pub fn vpn_parse_subscription(sub_text: String) -> Result<Vec<VpnNode>, String> {
    let nodes = parse_subscription(&sub_text);
    if nodes.is_empty() {
        return Err("no usable nodes parsed from subscription".into());
    }
    Ok(nodes)
}

/// Fetch a subscription URL server-side (blocking ureq on a worker thread) and
/// return the raw body. Done in Rust to bypass the webview's CORS restrictions
/// on cross-origin fetch.
#[tauri::command]
pub async fn vpn_fetch_subscription(url: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .timeout(std::time::Duration::from_secs(20))
            .set("User-Agent", "NexuSSH")
            .call()
            .map_err(|e| e.to_string())?;
        resp.into_string().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vless_reality_vision() {
        let link = "vless://11111111-2222-3333-4444-555555555555@81.177.166.155:443?security=reality&flow=xtls-rprx-vision&sni=chat.hipogas.org&fp=chrome&pbk=ABCpub&sid=ab12&spx=%2F&type=tcp#%F0%9F%87%AB%F0%9F%87%B7%20%D0%A4%D1%80%D0%B0%D0%BD%D1%86%D0%B8%D1%8F";
        let n = parse_share_link(link).expect("should parse");
        assert_eq!(n.address, "81.177.166.155");
        assert_eq!(n.port, 443);
        assert_eq!(n.security, "reality");
        assert_eq!(n.flow, "xtls-rprx-vision");
        assert_eq!(n.sni, "chat.hipogas.org");
        assert_eq!(n.public_key, "ABCpub");
        assert_eq!(n.spider_x, "/");
        assert!(n.tag.contains("Франция"));
        let cfg = xray_config(&n, 10808);
        assert_eq!(cfg["inbounds"][0]["port"], 10808);
        assert_eq!(cfg["outbounds"][0]["streamSettings"]["security"], "reality");
        assert_eq!(
            cfg["outbounds"][0]["settings"]["vnext"][0]["users"][0]["flow"],
            "xtls-rprx-vision"
        );
    }

    #[test]
    fn parses_base64_subscription() {
        let links = "vless://u@h.example:443?security=tls&sni=h.example&type=ws&path=%2Fws&host=h.example#node1";
        let b64 = general_purpose::STANDARD.encode(links);
        let nodes = parse_subscription(&b64);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].network, "ws");
        assert_eq!(nodes[0].path, "/ws");
        assert_eq!(nodes[0].security, "tls");
    }

    #[test]
    fn skips_unsupported_schemes() {
        assert!(parse_share_link("vmess://eyJ2IjoiMiJ9").is_none());
        assert!(parse_share_link("garbage").is_none());
    }
}
