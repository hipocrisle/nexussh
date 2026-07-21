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
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Shared, capped ring buffer of openconnect's own log lines for one tunnel — so
/// a bring-up failure can be reported with openconnect's REAL reason (auth / cert
/// / DNS) instead of a downstream "host unreachable".
pub type VpnLog = Arc<Mutex<Vec<String>>>;

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

/// Parse a whole subscription body (base64 / plain share-links / XRAY-JSON) into
/// nodes. Servers that target Happ hand out an XRAY-JSON array (a list of full
/// xray configs, each with `remarks` + a vless `proxy` outbound) instead of
/// vless:// lines — our own server does this for cascade/auto-select users. We
/// bundle xray, so those configs ARE usable: lift the vless outbound out of each.
pub fn parse_subscription(text: &str) -> Vec<VpnNode> {
    let body = maybe_b64_decode(text);
    let t = body.trim_start();
    if t.starts_with('[') || t.starts_with('{') {
        let nodes = parse_xray_json_nodes(&body);
        if !nodes.is_empty() {
            return nodes;
        }
    }
    body.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(parse_share_link)
        .collect()
}

/// XRAY-JSON subscription: a JSON array of xray configs (or a single object).
fn parse_xray_json_nodes(body: &str) -> Vec<VpnNode> {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    match v {
        Value::Array(arr) => arr.iter().filter_map(node_from_xray_config).collect(),
        Value::Object(_) => node_from_xray_config(&v).into_iter().collect(),
        _ => vec![],
    }
}

fn jstr(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Lift a VpnNode out of one xray config: take its `remarks` as the tag and the
/// first vless outbound that has a vnext target (prefer the one tagged "proxy").
/// Configs whose proxy is a balancer (e.g. an "auto-select" entry) have no single
/// vnext outbound here — we take the first concrete vless outbound, or skip.
fn node_from_xray_config(cfg: &Value) -> Option<VpnNode> {
    let remarks = jstr(cfg, "remarks");
    let obs = cfg.get("outbounds")?.as_array()?;
    let is_vless_vnext = |o: &&Value| {
        o.get("protocol").and_then(|p| p.as_str()) == Some("vless")
            && o.pointer("/settings/vnext/0").is_some()
    };
    let ob = obs
        .iter()
        .find(|o| o.get("tag").and_then(|t| t.as_str()) == Some("proxy") && is_vless_vnext(o))
        .or_else(|| obs.iter().find(is_vless_vnext))?;

    let vnext = ob.pointer("/settings/vnext/0")?;
    let address = vnext.get("address")?.as_str()?.to_string();
    let port = vnext.get("port")?.as_u64()? as u16;
    let user = vnext.pointer("/users/0")?;
    let uuid = user.get("id")?.as_str()?.to_string();
    let flow = user.get("flow").and_then(|x| x.as_str()).unwrap_or("").to_string();

    let empty = json!({});
    let ss = ob.get("streamSettings").unwrap_or(&empty);
    let network = ss.get("network").and_then(|x| x.as_str()).unwrap_or("tcp").to_string();
    let security = ss.get("security").and_then(|x| x.as_str()).unwrap_or("none").to_string();

    let (mut sni, mut fp, mut pbk, mut sid, mut spx, mut alpn) = (
        String::new(), String::new(), String::new(), String::new(), String::new(), String::new(),
    );
    if let Some(r) = ss.get("realitySettings") {
        sni = jstr(r, "serverName");
        fp = jstr(r, "fingerprint");
        pbk = jstr(r, "publicKey");
        sid = jstr(r, "shortId");
        spx = jstr(r, "spiderX");
    } else if let Some(tl) = ss.get("tlsSettings") {
        sni = jstr(tl, "serverName");
        fp = jstr(tl, "fingerprint");
        if let Some(a) = tl.get("alpn").and_then(|x| x.as_array()) {
            alpn = a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(",");
        }
    }
    let (mut path, mut host) = (String::new(), String::new());
    if let Some(ws) = ss.get("wsSettings") {
        path = jstr(ws, "path");
        host = ws.pointer("/headers/Host").and_then(|x| x.as_str()).unwrap_or("").to_string();
    } else if let Some(g) = ss.get("grpcSettings") {
        path = jstr(g, "serviceName");
    }

    Some(VpnNode {
        tag: if remarks.is_empty() { address.clone() } else { remarks },
        protocol: "vless".into(),
        address,
        port,
        uuid,
        security,
        flow,
        network,
        sni,
        fingerprint: fp,
        public_key: pbk,
        short_id: sid,
        spider_x: spx,
        path,
        host_header: host,
        alpn,
    })
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

/// Per-user runtime dir for xray configs. On Unix we use `$HOME/.cache/nexussh`
/// (a per-user location, never shared `/tmp`) created 0700; on Windows the
/// temp dir is already per-user. This keeps the VPN-credential config out of a
/// world-readable directory.
pub(crate) fn runtime_dir() -> std::io::Result<std::path::PathBuf> {
    #[cfg(unix)]
    let dir = {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(".cache").join("nexussh");
        std::fs::create_dir_all(&dir)?;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        dir
    };
    #[cfg(not(unix))]
    let dir = {
        let dir = std::env::temp_dir().join("nexussh");
        std::fs::create_dir_all(&dir)?;
        dir
    };
    Ok(dir)
}

/// Write `bytes` to `path` with owner-only (0600) permissions on Unix, so the
/// VPN-credential config can't be read by other local users.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::File::create(path)?.write_all(bytes)
    }
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
    let cfg = xray_config(node, socks_port);
    let bytes = serde_json::to_vec(&cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // The config holds VPN credentials (node UUID, Reality keys). Write it into a
    // per-user 0700 dir with 0600 perms — NOT shared /tmp world-readable (0644),
    // where any local account could read the subscription secret.
    let dir = runtime_dir()?;
    let path = dir.join(format!("nexussh-xray-{socks_port}.json"));
    write_private(&path, &bytes)?;
    let mut cmd = tokio::process::Command::new(xray_bin_path());
    cmd.arg("run")
        .arg("-c")
        .arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // Windows: xray is a console app — spawning it from the GUI pops an empty
    // cmd window that lingers for the session's life. CREATE_NO_WINDOW hides it.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let child = cmd.spawn()?;
    // Windows: attach xray to a kill-on-job-close Job Object so it dies whenever
    // NexuSSH dies — clean exit, crash, or Task Manager kill. Otherwise a force-
    // quit leaves xray.exe running, and the next installer can't overwrite it.
    #[cfg(windows)]
    attach_to_job(&child);
    Ok(child)
}

#[cfg(windows)]
fn attach_to_job(child: &tokio::process::Child) {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // One job per process; all xray children join it. The job handle is never
    // closed explicitly — Windows closes it when the parent process exits
    // (clean OR abrupt), and KILL_ON_JOB_CLOSE then terminates every assigned
    // child. HANDLE isn't Send/Sync so we stash it as usize.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h.is_null() {
            return 0;
        }
        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..std::mem::zeroed()
            },
            ..std::mem::zeroed()
        };
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        h as usize
    });
    if job == 0 {
        return;
    }
    let Some(raw) = child.raw_handle() else { return };
    unsafe {
        AssignProcessToJobObject(job as HANDLE, raw as HANDLE);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Corp VPN (Cisco AnyConnect / ocserv) via openconnect + ocproxy → SOCKS.
//
// Same userspace-SOCKS model as the xray built-in VPN: openconnect connects the
// AnyConnect tunnel but, with `--script-tun`, hands packets to `ocproxy` instead
// of a TUN device — ocproxy runs a userspace lwIP stack and exposes a SOCKS5
// proxy on 127.0.0.1:<port>. No TUN, no root/elevation; NexuSSH routes its SSH/
// SFTP through that SOCKS exactly like it does for xray. TCP-only (SSH is TCP).
// Mechanism validated end-to-end 2026-07-18 against a test ocserv.
// ─────────────────────────────────────────────────────────────────────────────

/// A saved corporate-VPN endpoint. The password is NEVER stored here — it is
/// supplied per-connect (prompted, like an SSH 2FA/password prompt). The server
/// cert pin is captured via TOFU on first connect (like an SSH host key).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpVpnProfile {
    /// Display name, e.g. "Работа".
    pub name: String,
    /// ocserv/AnyConnect server: `host`, `host:port`, or `https://host:port`.
    pub server: String,
    /// Saved username (optional default; the connect flow may override it).
    #[serde(default)]
    pub username: String,
    /// Trusted server cert pin `pin-sha256:BASE64` (TOFU). Empty = not yet
    /// trusted → the connect flow must probe the pin and get user approval first.
    #[serde(default)]
    pub server_cert: String,
    /// AnyConnect auth group (`--authgroup`), if the server uses one. Empty = none.
    #[serde(default)]
    pub authgroup: String,
    /// Optional tunnel MTU override (openconnect `--mtu`). Empty = auto-negotiate.
    /// Lowering it (try 1300, then 1200) fixes SSH to MTU-picky endpoints — most
    /// notably Cisco IOS — that black-hole full-size KEX packets through the
    /// AnyConnect tunnel (symptom: Linux hosts on the same VPN connect fine, a
    /// Cisco on the same subnet alternates timeout / connection-refused).
    #[serde(default)]
    pub mtu: String,
}

/// Normalize a server field into an `https://…` URL openconnect accepts.
fn oc_server_url(server: &str) -> String {
    let s = server.trim().trim_end_matches('/');
    if s.starts_with("https://") {
        s.to_string()
    } else if let Some(rest) = s.strip_prefix("http://") {
        format!("https://{rest}")
    } else {
        format!("https://{s}")
    }
}

/// Build the openconnect argv for a SOCKS-mode (ocproxy) connect. The password is
/// fed on stdin (`--passwd-on-stdin`), never on argv — argv is world-readable via
/// /proc/<pid>/cmdline, so a password there would leak to other local users.
/// `--non-inter` guarantees openconnect never blocks on a tty prompt (untrusted
/// cert / missing field fail fast instead of hanging a headless child).
fn openconnect_args(
    profile: &CorpVpnProfile,
    username: &str,
    socks_port: u16,
    ocproxy_bin: &std::path::Path,
) -> Vec<String> {
    let mut a = vec![
        "--protocol=anyconnect".to_string(),
        format!("--user={username}"),
        "--passwd-on-stdin".to_string(),
        "--non-inter".to_string(),
    ];
    // SOCKS transport differs by platform. Stock openconnect exposes a userspace
    // SOCKS only via `--script-tun` + ocproxy over a UNIX socket — which does NOT
    // work on Windows. So on Windows we ship the openconnect fork that adds a
    // native `--socks5-port` (SOCKS built in, no ocproxy, no unix socket); on
    // Unix we use the stock openconnect + bundled/system ocproxy.
    #[cfg(windows)]
    {
        let _ = ocproxy_bin; // native SOCKS on Windows — ocproxy not used
        a.push("--socks5-port".to_string());
        a.push(socks_port.to_string());
    }
    #[cfg(not(windows))]
    {
        a.push("--script-tun".to_string());
        // openconnect runs the script via the shell → quote the path (it may live
        // under an app dir with spaces). ocproxy -D <port> = SOCKS5 listen.
        a.push(format!("--script=\"{}\" -D {}", ocproxy_bin.display(), socks_port));
    }
    if !profile.server_cert.trim().is_empty() {
        a.push(format!("--servercert={}", profile.server_cert.trim()));
    }
    if !profile.authgroup.trim().is_empty() {
        a.push(format!("--authgroup={}", profile.authgroup.trim()));
    }
    // Optional MTU clamp — propagates to ocproxy/lwIP (INTERNAL_IP4_MTU) so TCP
    // MSS inside the tunnel shrinks to fit, unblocking MTU-picky SSH endpoints.
    if let Ok(mtu) = profile.mtu.trim().parse::<u32>() {
        if mtu > 0 {
            a.push(format!("--mtu={mtu}"));
        }
    }
    a.push(oc_server_url(&profile.server));
    a
}

/// Extract the `pin-sha256:BASE64` token openconnect prints when it rejects an
/// untrusted / mismatched server certificate. Used by the TOFU probe.
pub fn parse_cert_pin(output: &str) -> Option<String> {
    let idx = output.find("pin-sha256:")?;
    let after = &output[idx + "pin-sha256:".len()..];
    let b64: String = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
        .collect();
    if b64.is_empty() {
        None
    } else {
        Some(format!("pin-sha256:{b64}"))
    }
}

/// Locate a corp-VPN helper binary (openconnect / ocproxy). Prefers one bundled
/// next to the app executable (Windows ships the .exe + DLLs there); on Linux it
/// falls back to the system copy on PATH, since the deb/rpm declares openconnect +
/// ocproxy as dependencies (which also drag in their shared libs — openconnect is
/// NOT a static single binary like xray, so we can't just ship the executable).
fn corp_bin_path(name: &str) -> std::path::PathBuf {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    // 0) on-demand backend downloaded into the per-user backends dir (primary —
    //    this is how the VPN backends ship now; the connect flow ensures it first).
    if let Some(p) = crate::backends::installed_path(name) {
        return p;
    }
    // 1) bundled next to the app executable (legacy / dev).
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) {
        let cand = dir.join(&file);
        if cand.exists() {
            return cand;
        }
    }
    // 2) system PATH (e.g. a distro-provided openconnect).
    if let Some(found) = which_on_path(&file) {
        return found;
    }
    // 3) fall back to the bare name so the spawn error names the missing binary.
    std::path::PathBuf::from(file)
}

/// Minimal `which`: return the first PATH entry containing an executable `file`.
fn which_on_path(file: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(file);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn openconnect_bin_path() -> std::path::PathBuf {
    corp_bin_path("openconnect")
}
fn ocproxy_bin_path() -> std::path::PathBuf {
    corp_bin_path("ocproxy")
}

/// Feed the password to a spawned child's stdin then close it (openconnect reads a
/// single line for `--passwd-on-stdin`). Kept separate so it's easy to see the
/// password only ever travels via the pipe, never argv.
async fn feed_password(child: &mut tokio::process::Child, password: &str) {
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let line = format!("{password}\n");
        let _ = stdin.write_all(line.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
}

/// Stream a child pipe line-by-line into the tunnel log buffer AND emit each line
/// on `corp-vpn-log`, so the UI can show the tunnel actually coming up (or the
/// exact line it failed on) live.
fn drain_pipe<R>(app: AppHandle, reader: R, log: VpnLog)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::AsyncBufReadExt;
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit("corp-vpn-log", json!({ "line": line }));
            if let Ok(mut b) = log.lock() {
                if b.len() >= 300 {
                    b.remove(0);
                }
                b.push(line);
            }
        }
    });
}

/// Classify openconnect's captured output into a human, actionable failure
/// reason. Returns None when nothing recognizable matched (caller falls back to
/// the raw tail). Kept pure for unit testing.
pub fn classify_openconnect_failure(lines: &[String]) -> Option<String> {
    let hay = lines.join("\n").to_lowercase();
    let has = |p: &str| hay.contains(p);
    if has("login failed")
        || has("authentication failed")
        || has("invalid credentials")
        || has("password required")
        || has("access denied")
    {
        Some("VPN authentication failed — check the VPN username/password".into())
    } else if has("certificate")
        && (has("failed") || has("reject") || has("mismatch") || has("differ") || has("doesn't match"))
    {
        Some("VPN server certificate rejected — re-trust the server in Settings → VPN".into())
    } else if has("cannot resolve")
        || has("could not resolve")
        || has("name or service not known")
    {
        Some("cannot resolve the VPN server address — check the server field".into())
    } else if has("connection refused")
        || has("connection timed out")
        || has("network is unreachable")
        || has("failed to open https connection")
        || has("failed to connect")
        || has("no route to host")
    {
        Some("cannot reach the VPN server — check the server address/port and your network".into())
    } else if (has("ocproxy") && (has("not found") || has("no such file"))) || has("script failed") {
        Some("VPN helper (ocproxy) failed to start — re-download the VPN backend".into())
    } else {
        None
    }
}

/// Best-effort failure message from a tunnel's log buffer: a recognized reason,
/// else the last few non-empty lines, else a generic note.
fn tunnel_failure_reason(log: &VpnLog) -> String {
    let lines = log.lock().map(|b| b.clone()).unwrap_or_default();
    if let Some(m) = classify_openconnect_failure(&lines) {
        return m;
    }
    let mut tail: Vec<String> = lines
        .iter()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .cloned()
        .collect();
    if tail.is_empty() {
        "the VPN tunnel did not come up (no output from openconnect)".into()
    } else {
        tail.reverse();
        tail.join(" · ")
    }
}

/// Spawn openconnect+ocproxy for `profile`, exposing a SOCKS5 proxy on
/// 127.0.0.1:`socks_port`. `kill_on_drop` tears the tunnel down with the owning
/// SSH session. Requires a trusted `profile.server_cert` (call the probe first if
/// empty). Userspace only — no TUN, no elevation. Returns the child plus a live
/// log buffer of openconnect's output.
pub async fn spawn_openconnect(
    app: &AppHandle,
    profile: &CorpVpnProfile,
    password: &str,
    socks_port: u16,
) -> std::io::Result<(tokio::process::Child, VpnLog)> {
    let username = if profile.username.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "corp VPN: username required",
        ));
    } else {
        profile.username.trim()
    };
    let ocproxy = ocproxy_bin_path();
    let args = openconnect_args(profile, username, socks_port, &ocproxy);
    let mut cmd = tokio::process::Command::new(openconnect_bin_path());
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // No bundled/system openconnect — on Linux it's a package the distro
            // provides (RHEL/Rocky need EPEL first); Windows ships it in-bundle.
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "openconnect not found — install it to use the OpenConnect VPN \
                 (Debian/Ubuntu: apt install openconnect ocproxy; RHEL/Rocky: \
                 enable EPEL then dnf install openconnect)",
            )
        } else {
            e
        }
    })?;
    feed_password(&mut child, password).await;
    #[cfg(windows)]
    attach_to_job(&child);
    let log: VpnLog = Arc::new(Mutex::new(Vec::new()));
    if let Some(out) = child.stdout.take() {
        drain_pipe(app.clone(), out, log.clone());
    }
    if let Some(err) = child.stderr.take() {
        drain_pipe(app.clone(), err, log.clone());
    }
    Ok((child, log))
}

/// Bring up the openconnect tunnel and wait until its SOCKS proxy is listening —
/// but if openconnect dies during bring-up (bad password, rejected cert, DNS,
/// unreachable server), fail immediately with openconnect's OWN reason instead of
/// waiting out the SOCKS timeout and reporting a misleading "host unreachable".
/// Emits `corp-vpn-status` lifecycle events (connecting / up / error) for the UI.
pub async fn establish_corp_tunnel(
    app: &AppHandle,
    profile: &CorpVpnProfile,
    password: &str,
    socks_port: u16,
) -> Result<tokio::process::Child, String> {
    let _ = app.emit(
        "corp-vpn-status",
        json!({ "phase": "connecting", "server": profile.server }),
    );
    let (mut child, log) = spawn_openconnect(app, profile, password, socks_port)
        .await
        .map_err(|e| {
            let m = e.to_string();
            let _ = app.emit("corp-vpn-status", json!({ "phase": "error", "reason": m }));
            m
        })?;

    // Readiness = openconnect reports the VPN data plane ACTUALLY up (its own
    // "Connected as <ip>" / DTLS / ESP log line) AND the SOCKS proxy accepts.
    // Just the SOCKS port opening is NOT enough: the Windows fork opens its
    // listener before the session authenticates, so trusting the port alone
    // cached a dead "zombie" tunnel (socks up, no ocserv session, no traffic —
    // and then reused forever, ignoring password/MTU changes). We also watch the
    // child exiting for a fast, specific failure. Time-boxed so a hung bring-up
    // fails loudly instead of hanging or caching a zombie.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(35);
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            let reason = tunnel_failure_reason(&log);
            let _ = app.emit("corp-vpn-status", json!({ "phase": "error", "reason": reason }));
            return Err(reason);
        }
        if log_shows_connected(&log)
            && tokio::net::TcpStream::connect(("127.0.0.1", socks_port))
                .await
                .is_ok()
        {
            let _ = app.emit("corp-vpn-status", json!({ "phase": "up" }));
            return Ok(child);
        }
        if tokio::time::Instant::now() >= deadline {
            let mut reason = tunnel_failure_reason(&log);
            if reason.trim().is_empty() {
                reason = "the VPN tunnel did not finish connecting in time".to_string();
            }
            let _ = child.kill().await;
            let _ = app.emit("corp-vpn-status", json!({ "phase": "error", "reason": reason }));
            return Err(reason);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// Whether openconnect's log shows the VPN data plane is actually established (a
/// tunnel IP was assigned / a data channel came up) — as opposed to merely a TLS
/// connection or an open SOCKS listener.
fn log_shows_connected(log: &VpnLog) -> bool {
    let lines = log.lock().map(|b| b.clone()).unwrap_or_default();
    let hay = lines.join("\n").to_lowercase();
    // "Connected as 10.x.x.x, using SSL/DTLS" is printed by mainline openconnect
    // (and the fork) once it has a tunnel IP. The others cover DTLS/ESP data
    // channels. NOT "connected to HTTPS on ..." — that's just the TLS control.
    hay.contains("connected as")
        || hay.contains("cstp connected")
        || hay.contains("esp session established")
        || hay.contains("established dtls")
        || hay.contains("session established")
}

// ── Shared corp-VPN tunnel manager ───────────────────────────────────────────
// ONE openconnect tunnel per (server, user, authgroup) identity, shared by every
// SSH / SFTP / port-forward that routes through the same profile. Reference-
// counted: the tunnel is established on the first acquire (password prompted
// once), REUSED without re-auth by later acquires (so N concurrent hosts on one
// profile don't each open a second ocserv session that the server would reject),
// and torn down a short grace period after the LAST release — so neither the
// tunnel nor the password lingers once nothing uses it.

/// Identity that shares a tunnel: same server+user+group → same tunnel. (The
/// password isn't part of the key — a live tunnel is reused as-is.)
fn tunnel_key(p: &CorpVpnProfile) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        p.server.trim(),
        p.username.trim(),
        p.authgroup.trim()
    )
}

struct TunnelEntry {
    socks_port: u16,
    child: tokio::process::Child,
    refcount: usize,
    /// Bumped on every acquire-reuse and every teardown-schedule; a scheduled
    /// teardown only fires if the generation still matches, so a re-acquire
    /// during the grace window (or a later schedule) cancels the stale timer.
    generation: u64,
}

#[derive(Default)]
pub struct CorpTunnelManager {
    inner: tokio::sync::Mutex<HashMap<String, TunnelEntry>>,
}

static CORP_TUNNELS: std::sync::OnceLock<CorpTunnelManager> = std::sync::OnceLock::new();
fn tunnels() -> &'static CorpTunnelManager {
    CORP_TUNNELS.get_or_init(CorpTunnelManager::default)
}

const TEARDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// A live reference to a shared tunnel. SSH/SFTP/forward sessions hold one; when
/// dropped it releases the tunnel (scheduling teardown after the grace period if
/// it was the last user). Dial the tunnel through `socks_port`.
pub struct TunnelGuard {
    key: String,
    pub socks_port: u16,
}

impl Drop for TunnelGuard {
    fn drop(&mut self) {
        let key = std::mem::take(&mut self.key);
        // release is async; hand it to the runtime. Safe even during shutdown —
        // if there's no runtime the tunnel is dying with the process anyway.
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            h.spawn(async move { release_tunnel(&key).await });
        }
    }
}

/// Acquire (establishing if needed) the shared tunnel for `profile`. A live
/// tunnel is reused without the password; only a first/dead tunnel needs it.
pub async fn acquire_tunnel(
    app: &AppHandle,
    profile: &CorpVpnProfile,
    password: &str,
) -> Result<TunnelGuard, String> {
    let key = tunnel_key(profile);
    let mut map = tunnels().inner.lock().await;
    if let Some(e) = map.get_mut(&key) {
        // Reuse only if the tunnel process is still alive.
        if matches!(e.child.try_wait(), Ok(None)) {
            e.refcount += 1;
            e.generation += 1; // cancel any pending teardown
            let _ = app.emit("corp-vpn-status", json!({ "phase": "up" }));
            return Ok(TunnelGuard {
                key,
                socks_port: e.socks_port,
            });
        }
        // Tunnel died (server dropped it, crash) — drop the stale entry, re-establish.
        map.remove(&key);
    }
    let socks_port = crate::ssh::free_local_port().map_err(|e| e.to_string())?;
    let child = establish_corp_tunnel(app, profile, password, socks_port).await?;
    map.insert(
        key.clone(),
        TunnelEntry {
            socks_port,
            child,
            refcount: 1,
            generation: 0,
        },
    );
    Ok(TunnelGuard { key, socks_port })
}

/// Drop one reference; when the last goes, schedule teardown after the grace
/// window (cancelled if the tunnel is re-acquired meanwhile).
async fn release_tunnel(key: &str) {
    let generation = {
        let mut map = tunnels().inner.lock().await;
        let Some(e) = map.get_mut(key) else { return };
        e.refcount = e.refcount.saturating_sub(1);
        if e.refcount > 0 {
            return;
        }
        e.generation += 1;
        e.generation
    };
    let key = key.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(TEARDOWN_GRACE).await;
        let mut map = tunnels().inner.lock().await;
        // Tear down only if still idle AND untouched since we scheduled (a
        // re-acquire would have bumped refcount and generation).
        let still_idle = map
            .get(&key)
            .map(|e| e.refcount == 0 && e.generation == generation)
            .unwrap_or(false);
        if still_idle {
            if let Some(mut e) = map.remove(&key) {
                let _ = e.child.kill().await;
            }
        }
    });
}

/// Kill every live shared tunnel, synchronously — for app exit. The tunnel
/// children live in a `static` map that never runs Drop (so kill_on_drop won't
/// fire on quit), which on Unix would orphan openconnect+ocproxy. `start_kill`
/// just sends the signal (no await / runtime needed). Windows also has the Job
/// Object as a backstop. Best-effort: skips if the map is momentarily locked.
pub fn shutdown_all_tunnels() {
    if let Some(mgr) = CORP_TUNNELS.get() {
        if let Ok(mut map) = mgr.inner.try_lock() {
            for e in map.values_mut() {
                let _ = e.child.start_kill();
            }
            map.clear();
        }
    }
}

/// Force-tear-down every shared tunnel right now — manual recovery from a wedged
/// state (e.g. a tunnel whose VPN session silently died while the process stayed
/// alive). Returns how many were killed. The next connect re-establishes and
/// re-prompts for the password.
#[tauri::command]
pub async fn corp_vpn_disconnect_all() -> usize {
    let mut map = tunnels().inner.lock().await;
    let n = map.len();
    for (_, mut e) in map.drain() {
        let _ = e.child.kill().await;
    }
    n
}

/// Whether a shared tunnel for this profile is currently up (so the connect flow
/// can skip the password prompt and reuse it). Keyed by server+user+group like
/// the tunnel itself.
#[tauri::command]
pub async fn corp_tunnel_active(profile: CorpVpnProfile) -> bool {
    let key = tunnel_key(&profile);
    let mut map = tunnels().inner.lock().await;
    match map.get_mut(&key) {
        Some(e) => matches!(e.child.try_wait(), Ok(None)),
        None => false,
    }
}

/// What a session holds to keep its transport alive for its whole lifetime:
/// - `Xray`  — the bundled xray sidecar (killed on drop via kill_on_drop).
/// - `Corp`  — a shared corp-VPN tunnel reference (releases on drop; the tunnel
///             itself is torn down only when the LAST holder releases + grace).
/// - `None`  — a direct connection, nothing to hold.
pub enum TransportHold {
    None,
    Xray(tokio::process::Child),
    Corp(TunnelGuard),
    /// System L2TP/IPsec VPN reference — the OS routes; SSH goes direct.
    System(crate::l2tp::SystemVpnGuard),
}

/// TOFU probe: connect just far enough for openconnect to present the server cert,
/// pinned against a deliberately-wrong fingerprint so openconnect prints the
/// server's real `pin-sha256:…` and exits. Returns that pin for the UI to show
/// the user (trust prompt), mirroring SSH host-key TOFU. No password needed — the
/// cert check happens during the TLS handshake, before authentication.
pub async fn openconnect_probe_cert(profile: &CorpVpnProfile) -> Result<String, String> {
    let ocproxy = ocproxy_bin_path();
    // Bogus pin forces a mismatch → openconnect prints the real pin.
    let bogus = CorpVpnProfile {
        server_cert: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .to_string(),
        ..profile.clone()
    };
    let user = if bogus.username.trim().is_empty() { "probe" } else { bogus.username.trim() };
    // The probe never actually opens a SOCKS listener (the bogus cert is rejected
    // during the TLS handshake, before any tunnel/SOCKS setup), but the Windows
    // openconnect fork VALIDATES `--socks5-port` up front and rejects 0 ("must be
    // between 1 and 65535"). So hand it a real free port instead of 0.
    let probe_port = crate::ssh::free_local_port().unwrap_or(11080);
    let args = openconnect_args(&bogus, user, probe_port, &ocproxy);
    let mut cmd = tokio::process::Command::new(openconnect_bin_path());
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "openconnect not found — install it to use the OpenConnect VPN \
             (Debian/Ubuntu: apt install openconnect ocproxy; RHEL/Rocky: \
             enable EPEL then dnf install openconnect)".to_string()
        } else {
            format!("openconnect spawn: {e}")
        }
    })?;
    // openconnect (--passwd-on-stdin) reads a password from stdin BEFORE the TLS
    // cert check — closing stdin makes its fgets() fail ("fgets (stdin)") and it
    // exits before printing the pin. Feed a throwaway password: the bogus
    // --servercert rejects the certificate long before this password is ever
    // validated, so its value is irrelevant — we only want the printed pin.
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(b"x\n").await;
        let _ = stdin.shutdown().await;
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output())
        .await
        .map_err(|_| "cert probe timed out".to_string())
        .and_then(|r| r.map_err(|e| e.to_string()))?;
    let mut combined = String::from_utf8_lossy(&out.stderr).into_owned();
    combined.push_str(&String::from_utf8_lossy(&out.stdout));
    parse_cert_pin(&combined)
        .ok_or_else(|| format!("could not read server cert pin from openconnect output: {}",
            combined.lines().rev().take(4).collect::<Vec<_>>().join(" | ")))
}

/// Tauri command: probe a corp-VPN server's cert pin for the TOFU trust prompt.
#[tauri::command]
pub async fn corp_vpn_probe_cert(profile: CorpVpnProfile) -> Result<String, String> {
    openconnect_probe_cert(&profile).await
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
    // Require HTTPS — the subscription body carries VPN credentials (VLESS
    // UUIDs / Reality keys). Over plain HTTP a network MITM could read them and
    // substitute attacker nodes, routing the user's SSH through themselves.
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") {
        return Err("subscription URL must use https:// (refusing plaintext fetch)".into());
    }
    let url = trimmed.to_string();
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

    fn lines(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn tunnel_key_shares_by_server_user_group() {
        let base = CorpVpnProfile {
            name: "A".into(),
            server: "vpn.corp:4443".into(),
            username: "ivan".into(),
            server_cert: "pin-sha256:x".into(),
            authgroup: "grp".into(),
            mtu: String::new(),
        };
        // Same server+user+group → same key (shares one tunnel), even if the
        // display name / trusted cert differ.
        let same = CorpVpnProfile {
            name: "B".into(),
            server_cert: "pin-sha256:y".into(),
            ..base.clone()
        };
        assert_eq!(tunnel_key(&base), tunnel_key(&same));
        // Different user → different tunnel.
        let other_user = CorpVpnProfile { username: "petr".into(), ..base.clone() };
        assert_ne!(tunnel_key(&base), tunnel_key(&other_user));
        // Different group → different tunnel.
        let other_grp = CorpVpnProfile { authgroup: "grp2".into(), ..base.clone() };
        assert_ne!(tunnel_key(&base), tunnel_key(&other_grp));
    }

    #[test]
    fn classifies_common_openconnect_failures() {
        // Real openconnect wording.
        assert!(classify_openconnect_failure(&lines(&["POST https://x/", "Login failed."]))
            .unwrap()
            .contains("authentication failed"));
        assert!(classify_openconnect_failure(&lines(&[
            "Server certificate verify failed: signer not found"
        ]))
        .unwrap()
        .contains("certificate"));
        assert!(
            classify_openconnect_failure(&lines(&["Failed to open HTTPS connection to bad.host"]))
                .unwrap()
                .contains("reach the VPN server")
        );
        assert!(classify_openconnect_failure(&lines(&["getaddrinfo: Name or service not known"]))
            .unwrap()
            .contains("resolve"));
        // A clean progress log isn't a failure.
        assert!(classify_openconnect_failure(&lines(&[
            "Connected to HTTPS on nsk1.wlvpn.online",
            "Established DTLS connection"
        ]))
        .is_none());
    }

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

#[cfg(test)]
mod xray_json_tests {
    use super::*;

    #[test]
    fn parses_xray_json_array() {
        let body = r#"[
          {"remarks":"🇫🇷 Франция · Vless","outbounds":[
            {"tag":"proxy","protocol":"vless","settings":{"vnext":[{"address":"81.177.166.155","port":443,"users":[{"id":"abc","encryption":"none"}]}]},"streamSettings":{"network":"ws","security":"tls","tlsSettings":{"serverName":"chat.hipogas.org","fingerprint":"chrome"},"wsSettings":{"path":"/9e3fb428e21f7336","headers":{}}}},
            {"tag":"direct","protocol":"freedom"},{"tag":"block","protocol":"blackhole"}]},
          {"remarks":"🌍 АВТОВЫБОР","outbounds":[
            {"tag":"proxy-1","protocol":"vless","settings":{"vnext":[{"address":"81.177.166.155","port":443,"users":[{"id":"def","encryption":"none"}]}]},"streamSettings":{"network":"ws","security":"tls","tlsSettings":{"serverName":"chat.hipogas.org"},"wsSettings":{"path":"/p"}}},
            {"tag":"direct","protocol":"freedom"}]}
        ]"#;
        let nodes = parse_subscription(body);
        assert_eq!(nodes.len(), 2, "should lift one node per config");
        assert_eq!(nodes[0].tag, "🇫🇷 Франция · Vless");
        assert_eq!(nodes[0].address, "81.177.166.155");
        assert_eq!(nodes[0].port, 443);
        assert_eq!(nodes[0].uuid, "abc");
        assert_eq!(nodes[0].network, "ws");
        assert_eq!(nodes[0].security, "tls");
        assert_eq!(nodes[0].sni, "chat.hipogas.org");
        assert_eq!(nodes[0].path, "/9e3fb428e21f7336");
        // auto-select: no "proxy" tag → first vless outbound (proxy-1)
        assert_eq!(nodes[1].tag, "🌍 АВТОВЫБОР");
        assert_eq!(nodes[1].uuid, "def");
    }

    #[test]
    fn vless_lines_still_work() {
        let body = "vless://uuid-1@1.2.3.4:443?security=reality&type=tcp&sni=x.com&pbk=KEY&sid=ab#Node1";
        let nodes = parse_subscription(body);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].uuid, "uuid-1");
        assert_eq!(nodes[0].security, "reality");
    }
}

#[cfg(test)]
mod corp_vpn_tests {
    use super::*;
    use std::path::Path;

    fn prof() -> CorpVpnProfile {
        CorpVpnProfile {
            name: "Работа".into(),
            server: "vpn.corp.example:4443".into(),
            username: "alice".into(),
            server_cert: "pin-sha256:U8sH35+o9alC7JK6QcQmiQ6Q2hfQPcTPMDPSWyNV6fI=".into(),
            authgroup: String::new(),
            mtu: String::new(),
        }
    }

    #[test]
    fn server_url_normalization() {
        assert_eq!(oc_server_url("vpn.corp.example"), "https://vpn.corp.example");
        assert_eq!(oc_server_url("vpn.corp.example:4443"), "https://vpn.corp.example:4443");
        assert_eq!(oc_server_url("https://vpn.corp.example:4443/"), "https://vpn.corp.example:4443");
        assert_eq!(oc_server_url("http://vpn.corp.example"), "https://vpn.corp.example");
        assert_eq!(oc_server_url("  vpn.corp.example/  "), "https://vpn.corp.example");
    }

    #[test]
    fn args_have_the_validated_recipe() {
        let a = openconnect_args(&prof(), "alice", 11080, Path::new("/opt/nexussh/ocproxy"));
        assert!(a.contains(&"--protocol=anyconnect".to_string()));
        assert!(a.contains(&"--user=alice".to_string()));
        assert!(a.contains(&"--passwd-on-stdin".to_string()), "password must go via stdin, not argv");
        assert!(a.contains(&"--non-inter".to_string()), "must never block on a tty prompt");
        #[cfg(not(windows))]
        {
            assert!(a.contains(&"--script-tun".to_string()));
            assert!(a.iter().any(|s| s == "--script=\"/opt/nexussh/ocproxy\" -D 11080"));
        }
        #[cfg(windows)]
        {
            // Windows fork: native SOCKS, no ocproxy/--script-tun.
            assert!(a.contains(&"--socks5-port".to_string()));
            assert!(a.contains(&"11080".to_string()));
            assert!(!a.contains(&"--script-tun".to_string()));
        }
        assert!(a.iter().any(|s| s.starts_with("--servercert=pin-sha256:")));
        // server URL is the last positional arg
        assert_eq!(a.last().unwrap(), "https://vpn.corp.example:4443");
    }

    #[test]
    fn password_never_in_argv() {
        // openconnect_args takes no password at all — proves it can't leak to argv.
        let a = openconnect_args(&prof(), "alice", 11080, Path::new("ocproxy"));
        assert!(!a.iter().any(|s| s.contains("hunter2") || s.to_lowercase().contains("passw") && s.contains('=') && !s.starts_with("--passwd-on-stdin")));
    }

    #[test]
    fn no_servercert_arg_when_untrusted() {
        let mut p = prof();
        p.server_cert = String::new();
        let a = openconnect_args(&p, "alice", 11080, Path::new("ocproxy"));
        assert!(!a.iter().any(|s| s.starts_with("--servercert")),
            "untrusted profile → no pin arg (probe/TOFU first)");
    }

    #[test]
    fn authgroup_included_when_set() {
        let mut p = prof();
        p.authgroup = "employees".into();
        let a = openconnect_args(&p, "alice", 11080, Path::new("ocproxy"));
        assert!(a.contains(&"--authgroup=employees".to_string()));
    }

    #[test]
    fn mtu_passed_only_when_a_valid_number() {
        let mut p = prof();
        // Empty → no --mtu (auto-negotiate).
        assert!(!openconnect_args(&p, "alice", 11080, Path::new("ocproxy"))
            .iter()
            .any(|s| s.starts_with("--mtu")));
        // Set → passed through.
        p.mtu = "1300".into();
        assert!(openconnect_args(&p, "alice", 11080, Path::new("ocproxy"))
            .contains(&"--mtu=1300".to_string()));
        // Junk / zero → ignored (no crash, no bogus arg).
        p.mtu = "abc".into();
        assert!(!openconnect_args(&p, "alice", 11080, Path::new("ocproxy"))
            .iter()
            .any(|s| s.starts_with("--mtu")));
        p.mtu = "0".into();
        assert!(!openconnect_args(&p, "alice", 11080, Path::new("ocproxy"))
            .iter()
            .any(|s| s.starts_with("--mtu")));
    }

    #[test]
    fn parses_pin_from_openconnect_output() {
        let out = "Server certificate verify failed: signer not found\n\
                   None of the 1 fingerprint(s) specified via --servercert match \
                   server's certificate: pin-sha256:U8sH35+o9alC7JK6QcQmiQ6Q2hfQPcTPMDPSWyNV6fI=\n\
                   SSL connection failure: Error in the certificate.";
        assert_eq!(
            parse_cert_pin(out).as_deref(),
            Some("pin-sha256:U8sH35+o9alC7JK6QcQmiQ6Q2hfQPcTPMDPSWyNV6fI=")
        );
    }

    #[test]
    fn pin_parse_none_when_absent() {
        assert_eq!(parse_cert_pin("Connected to server\nCSTP connected."), None);
    }

    #[test]
    #[cfg(unix)]
    fn which_finds_system_binary_and_rejects_bogus() {
        // `sh` is on PATH on every unix; a random name never is.
        assert!(which_on_path("sh").is_some(), "sh should be found on PATH");
        assert!(which_on_path("nexussh-no-such-binary-zzz").is_none());
    }
}
