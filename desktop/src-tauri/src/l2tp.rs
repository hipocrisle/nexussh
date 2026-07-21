//! System L2TP/IPsec VPN orchestration (Windows-first).
//!
//! Unlike openconnect — a userspace SOCKS proxy — L2TP/IPsec has no viable
//! userspace client (all implementations are kernel + root: strongSwan/libreswan
//! + xl2tpd + pppd), and there is no userspace IKEv1. So for L2TP/IPsec we drive
//! the OS's NATIVE stack instead. On Windows: `Add-VpnConnection` (L2TP + PSK) +
//! `rasdial` to connect/disconnect.
//!
//! Consequence: this is a SYSTEM tunnel (the OS routes it), NOT a per-host SOCKS
//! proxy. When a host routes through an L2TP profile we bring the system VPN up
//! (reference-counted, shared by every host on the profile) and the SSH TCP
//! connection goes DIRECT — the OS sends it over the VPN route. The VPN is torn
//! down a short grace period after the LAST host releases it.
//!
//! It is offered as just another VPN-profile type in the unified picker; the user
//! chooses per host whether to use xray / OpenConnect / L2TP / none.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A saved L2TP/IPsec endpoint. The PPP password is NOT stored here — it is
/// prompted per-connect (like the OpenConnect password). The PSK is a per-gateway
/// shared secret needed to configure the connection, kept with the profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct L2tpProfile {
    /// Display name, e.g. "Работа L2TP".
    pub name: String,
    /// Server host or IP.
    pub server: String,
    /// PPP username.
    #[serde(default)]
    pub username: String,
    /// IPsec pre-shared key.
    #[serde(default)]
    pub psk: String,
    /// Require encryption (maps to -EncryptionLevel Required vs Optional).
    #[serde(default)]
    pub require_encryption: bool,
    /// Optional extra split-tunnel routes (CIDRs) to send through the VPN, e.g.
    /// "10.180.100.0/24". The connecting SSH host's own address is always routed
    /// automatically, so this is only needed for broader reach.
    #[serde(default)]
    pub routes: Vec<String>,
}

/// Identity that shares one system connection: same server+user. (PSK isn't part
/// of the key — a live connection is reused as-is.)
fn conn_key(p: &L2tpProfile) -> String {
    format!("{}\u{0}{}", p.server.trim(), p.username.trim())
}

/// Deterministic Windows phonebook entry name for a profile, stable across
/// connects so Add/rasdial/Remove all target the same entry.
fn connection_name(p: &L2tpProfile) -> String {
    // A short stable hash of the identity keeps the name unique but tidy.
    let mut h: u64 = 1469598103934665603;
    for b in conn_key(p).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("NexuSSH-L2TP-{h:016x}")
}

// ── Reference-counted system-VPN manager ─────────────────────────────────────

struct ConnEntry {
    name: String,
    refcount: usize,
    generation: u64,
}

#[derive(Default)]
struct SystemVpnManager {
    inner: tokio::sync::Mutex<HashMap<String, ConnEntry>>,
}

static SYSTEM_VPNS: std::sync::OnceLock<SystemVpnManager> = std::sync::OnceLock::new();
fn vpns() -> &'static SystemVpnManager {
    SYSTEM_VPNS.get_or_init(SystemVpnManager::default)
}

const TEARDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// A live reference to a system VPN. Held by the SSH/SFTP/forward session; on
/// drop it releases the connection (disconnecting after the grace period if it
/// was the last user).
pub struct SystemVpnGuard {
    key: String,
}

impl Drop for SystemVpnGuard {
    fn drop(&mut self) {
        let key = std::mem::take(&mut self.key);
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            h.spawn(async move { release_system_vpn(&key).await });
        }
    }
}

/// Acquire (connecting if needed) the system VPN for `profile`. A live connection
/// is reused without the password; only a first/dead one needs it.
pub async fn acquire_system_vpn(
    app: &tauri::AppHandle,
    profile: &L2tpProfile,
    password: &str,
    host: &str,
) -> Result<SystemVpnGuard, String> {
    let key = conn_key(profile);
    let name = connection_name(profile);
    let mut map = vpns().inner.lock().await;
    if let Some(e) = map.get_mut(&key) {
        if is_connected(&e.name).await {
            e.refcount += 1;
            e.generation += 1; // cancel any pending teardown
            // The VPN is split-tunnel (not the default gateway), so make sure
            // THIS host is routed through it even though it's a reused tunnel.
            add_host_route(&e.name, host).await;
            emit_status(app, "up", None);
            return Ok(SystemVpnGuard { key });
        }
        map.remove(&key); // dropped/failed connection — reconnect below
    }
    emit_status(app, "connecting", Some(&profile.server));
    connect(profile, password, &name).await.map_err(|e| {
        emit_status(app, "error", Some(&e));
        e
    })?;
    add_host_route(&name, host).await;
    map.insert(
        key.clone(),
        ConnEntry {
            name,
            refcount: 1,
            generation: 0,
        },
    );
    emit_status(app, "up", None);
    Ok(SystemVpnGuard { key })
}

async fn release_system_vpn(key: &str) {
    let (name, generation) = {
        let mut map = vpns().inner.lock().await;
        let Some(e) = map.get_mut(key) else { return };
        e.refcount = e.refcount.saturating_sub(1);
        if e.refcount > 0 {
            return;
        }
        e.generation += 1;
        (e.name.clone(), e.generation)
    };
    let key = key.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(TEARDOWN_GRACE).await;
        let mut map = vpns().inner.lock().await;
        let still_idle = map
            .get(&key)
            .map(|e| e.refcount == 0 && e.generation == generation)
            .unwrap_or(false);
        if still_idle {
            map.remove(&key);
            disconnect(&name).await;
        }
    });
}

/// Force-disconnect every system VPN (manual recovery + app exit).
pub async fn disconnect_all() -> usize {
    let mut map = vpns().inner.lock().await;
    let names: Vec<String> = map.drain().map(|(_, e)| e.name).collect();
    let n = names.len();
    for name in names {
        disconnect(&name).await;
    }
    n
}

fn emit_status(app: &tauri::AppHandle, phase: &str, detail: Option<&str>) {
    use tauri::Emitter;
    // Reuse the same overlay channel as the corp VPN (it's VPN-type-agnostic).
    let _ = app.emit(
        "corp-vpn-status",
        serde_json::json!({ "phase": phase, "server": detail, "reason": detail }),
    );
}

// ── Windows implementation ───────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::L2tpProfile;
    use tokio::process::Command;

    fn hide() -> u32 {
        0x0800_0000 // CREATE_NO_WINDOW
    }

    /// Run a PowerShell snippet, returning (success, combined stdout+stderr).
    async fn ps(script: &str) -> (bool, String) {
        // tokio::process::Command provides `creation_flags` inherently on Windows.
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(hide())
            .output()
            .await;
        match out {
            Ok(o) => {
                let mut s = String::from_utf8_lossy(&o.stdout).to_string();
                s.push_str(&String::from_utf8_lossy(&o.stderr));
                (o.status.success(), s)
            }
            Err(e) => (false, format!("powershell: {e}")),
        }
    }

    /// PowerShell single-quote escape (double any embedded single quote).
    fn q(s: &str) -> String {
        s.replace('\'', "''")
    }

    pub async fn is_connected(name: &str) -> bool {
        let (_, out) = ps(&format!(
            "(Get-VpnConnection -Name '{}' -ErrorAction SilentlyContinue).ConnectionStatus",
            q(name)
        ))
        .await;
        out.trim().eq_ignore_ascii_case("Connected")
    }

    pub async fn connect(p: &L2tpProfile, password: &str, name: &str) -> Result<(), String> {
        let enc = if p.require_encryption { "Required" } else { "Optional" };
        // (Re)create the per-user phonebook entry idempotently. Per-user → no admin
        // for the entry itself; the IPsec negotiation runs via the SYSTEM IKEEXT
        // service. -Force overwrites an existing entry so edits take effect.
        //
        // -SplitTunneling $true is ALWAYS set: this is the "use remote gateway =
        // OFF" behaviour the user wants — the VPN must NOT become the default
        // gateway (don't send all traffic through it). Only the SSH host routes
        // (added below / per host) and any explicit profile routes go over it.
        let mut setup = format!(
            "$ErrorActionPreference='Stop'; \
             Add-VpnConnection -Name '{name}' -ServerAddress '{server}' \
               -TunnelType L2tp -L2tpPsk '{psk}' -EncryptionLevel {enc} \
               -AuthenticationMethod MSChapv2 -SplitTunneling $true \
               -RememberCredential:$false -Force -PassThru | Out-Null;",
            name = q(name),
            server = q(&p.server),
            psk = q(&p.psk),
        );
        for r in p.routes.iter().filter(|r| !r.trim().is_empty()) {
            setup.push_str(&format!(
                "Add-VpnConnectionRoute -ConnectionName '{name}' \
                   -DestinationPrefix '{r}' -ErrorAction SilentlyContinue | Out-Null;",
                name = q(name),
                r = q(r.trim())
            ));
        }
        let (ok, out) = ps(&setup).await;
        if !ok {
            return Err(format!("failed to configure the L2TP connection: {}", out.trim()));
        }

        // Connect. rasdial blocks until connected or failed and prints an error
        // code we can translate. Password on the command line is unavoidable for
        // rasdial, but it's a short-lived child with a hidden window.
        let out = Command::new("rasdial")
            .args([name, p.username.as_str(), password])
            .creation_flags(hide())
            .output()
            .await
            .map_err(|e| format!("rasdial: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Err(translate_rasdial_error(&text))
    }

    /// Route a single SSH host through the (split-tunnel) VPN. Applied live via
    /// New-NetRoute on the VPN adapter (same name as the connection) AND persisted
    /// on the connection, so it works both for a fresh connect and for a host that
    /// joins an already-up shared tunnel. Only literal IPs are auto-routed; a
    /// hostname target needs a profile route (we can't resolve it here reliably).
    pub async fn add_host_route(name: &str, host: &str) {
        let ip: std::net::IpAddr = match host.parse() {
            Ok(ip) => ip,
            Err(_) => return,
        };
        let prefix = if ip.is_ipv6() {
            format!("{host}/128")
        } else {
            format!("{host}/32")
        };
        let _ = ps(&format!(
            "New-NetRoute -DestinationPrefix '{p}' -InterfaceAlias '{name}' \
               -NextHop 0.0.0.0 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null; \
             Add-VpnConnectionRoute -ConnectionName '{name}' -DestinationPrefix '{p}' \
               -ErrorAction SilentlyContinue | Out-Null",
            p = prefix,
            name = q(name)
        ))
        .await;
    }

    pub async fn disconnect(name: &str) {
        let _ = ps(&format!("rasdial '{}' /disconnect", q(name))).await;
        // Tidy up the phonebook entry so we don't accumulate stale ones.
        let _ = ps(&format!(
            "Remove-VpnConnection -Name '{}' -Force -ErrorAction SilentlyContinue",
            q(name)
        ))
        .await;
    }

    /// Map the common rasdial/RAS error codes to an actionable message.
    fn translate_rasdial_error(text: &str) -> String {
        let has = |code: &str| text.contains(code);
        if has("691") {
            "L2TP login failed — check the username/password".into()
        } else if has("789") {
            "IPsec negotiation failed (error 789) — check the pre-shared key and that \
             the server offers L2TP/IPsec".into()
        } else if has("809") {
            "the server didn't respond (error 809) — this usually means L2TP/IPsec is \
             behind NAT and Windows needs the one-time registry fix \
             (AssumeUDPEncapsulationContextOnSendRule = 2, then reboot). UDP 500/4500 \
             must also be open".into()
        } else if has("628") || has("718") {
            "the connection was terminated by the server (check credentials / server config)".into()
        } else {
            let t = text.trim();
            if t.is_empty() {
                "failed to connect the L2TP VPN".into()
            } else {
                format!("L2TP connect failed: {t}")
            }
        }
    }
}

#[cfg(windows)]
async fn connect(p: &L2tpProfile, password: &str, name: &str) -> Result<(), String> {
    imp::connect(p, password, name).await
}
#[cfg(windows)]
async fn disconnect(name: &str) {
    imp::disconnect(name).await
}
#[cfg(windows)]
async fn is_connected(name: &str) -> bool {
    imp::is_connected(name).await
}
#[cfg(windows)]
async fn add_host_route(name: &str, host: &str) {
    imp::add_host_route(name, host).await
}

// ── Non-Windows: not implemented yet (Linux via NetworkManager-l2tp is a later
//    phase). Fail with a clear message rather than pretend. ────────────────────

#[cfg(not(windows))]
async fn connect(_p: &L2tpProfile, _password: &str, _name: &str) -> Result<(), String> {
    Err("System L2TP/IPsec is currently Windows-only".into())
}
#[cfg(not(windows))]
async fn disconnect(_name: &str) {}
#[cfg(not(windows))]
async fn is_connected(_name: &str) -> bool {
    false
}
#[cfg(not(windows))]
async fn add_host_route(_name: &str, _host: &str) {}

/// Whether a system VPN for this profile is currently up (so the connect flow can
/// skip the password prompt and reuse it).
#[tauri::command]
pub async fn l2tp_active(profile: L2tpProfile) -> bool {
    let key = conn_key(&profile);
    let map = vpns().inner.lock().await;
    match map.get(&key) {
        Some(e) => is_connected(&e.name).await,
        None => false,
    }
}

/// Force-disconnect all system VPNs (manual recovery from a wedged state).
#[tauri::command]
pub async fn l2tp_disconnect_all() -> usize {
    disconnect_all().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prof() -> L2tpProfile {
        L2tpProfile {
            name: "Work".into(),
            server: "vpn.example.com".into(),
            username: "alice".into(),
            psk: "secret".into(),
            require_encryption: true,
            routes: vec![],
        }
    }

    #[test]
    fn connection_name_is_stable_and_identity_scoped() {
        let a = prof();
        // Same server+user → same name (shares one system connection), even if PSK
        // or display name differ.
        let mut b = prof();
        b.name = "Other".into();
        b.psk = "different".into();
        assert_eq!(connection_name(&a), connection_name(&b));
        assert!(connection_name(&a).starts_with("NexuSSH-L2TP-"));
        // Different user → different connection.
        let mut c = prof();
        c.username = "bob".into();
        assert_ne!(connection_name(&a), connection_name(&c));
    }
}
