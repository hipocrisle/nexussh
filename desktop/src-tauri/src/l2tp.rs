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
            emit_status(app, "up", None);
            return Ok(SystemVpnGuard { key });
        }
        map.remove(&key); // dropped/failed connection — reconnect below
    }
    emit_status(app, "connecting", Some(&profile.server));
    // The host's /32 and any profile routes are baked into the connection during
    // the (elevated) setup, so the OS installs them on connect — no per-connect
    // admin, and the split-tunnel VPN actually reaches the host.
    connect(profile, password, &name, host).await.map_err(|e| {
        emit_status(app, "error", Some(&e));
        e
    })?;
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
    use base64::Engine as _;
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

    /// base64(UTF-16LE) for `powershell -EncodedCommand` — avoids all the quoting
    /// pain of passing a script (with a PSK) through Start-Process argv.
    fn encode_command(script: &str) -> String {
        let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// Run `inner` in an ELEVATED PowerShell (one UAC prompt). Needed because the
    /// L2TP pre-shared key is a machine-wide secret, so Add-VpnConnection -L2tpPsk
    /// requires admin (it writes the all-user phonebook). The elevated child
    /// writes any failure to `errfile` so we can surface a real reason; UAC-declined
    /// is distinguished by the absence of that file.
    async fn run_elevated(inner: &str) -> Result<(), String> {
        let errfile = std::env::temp_dir().join(format!("nexussh-l2tp-{}.err", std::process::id()));
        let _ = tokio::fs::remove_file(&errfile).await;
        let errpath = q(&errfile.to_string_lossy());
        let full = format!(
            "$ErrorActionPreference='Stop'; try {{ {inner} }} \
             catch {{ $_.Exception.Message | Out-File -FilePath '{errpath}' -Encoding utf8; exit 1 }}; exit 0"
        );
        let b64 = encode_command(&full);
        // Outer (non-elevated) launches the elevated child and propagates its exit
        // code; a thrown Start-Process = UAC declined → 1223 (ERROR_CANCELLED).
        let outer = format!(
            "try {{ $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
               -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{b64}'; exit $p.ExitCode }} \
             catch {{ exit 1223 }}"
        );
        let (ok, _) = ps(&outer).await;
        if ok {
            let _ = tokio::fs::remove_file(&errfile).await;
            return Ok(());
        }
        let msg = tokio::fs::read_to_string(&errfile)
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let _ = tokio::fs::remove_file(&errfile).await;
        Err(match msg {
            Some(m) => format!("L2TP setup failed: {m}"),
            None => "administrator permission is required to set up L2TP/IPsec (the pre-shared \
                     key is stored machine-wide) and it wasn't granted"
                .into(),
        })
    }

    pub async fn is_connected(name: &str) -> bool {
        let (_, out) = ps(&format!(
            "(Get-VpnConnection -AllUserConnection -Name '{}' -ErrorAction SilentlyContinue).ConnectionStatus",
            q(name)
        ))
        .await;
        out.trim().eq_ignore_ascii_case("Connected")
    }

    pub async fn connect(p: &L2tpProfile, password: &str, name: &str, host: &str) -> Result<(), String> {
        let enc = if p.require_encryption { "Required" } else { "Optional" };
        // Build the ELEVATED setup: it (idempotently, -Force) creates the all-user
        // L2TP connection with the PSK, proactively applies the NAT-T registry fix
        // (we're already elevated), and bakes in the split-tunnel routes so the OS
        // installs them on connect — no per-connect admin afterwards.
        //
        // -SplitTunneling $true = "use remote gateway" OFF: the VPN is NEVER the
        // default gateway; only the host + profile routes go through it.
        let mut inner = format!(
            "reg add 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\PolicyAgent' \
               /v AssumeUDPEncapsulationContextOnSendRule /t REG_DWORD /d 2 /f | Out-Null; \
             Add-VpnConnection -Name '{name}' -ServerAddress '{server}' -TunnelType L2tp \
               -L2tpPsk '{psk}' -EncryptionLevel {enc} -AuthenticationMethod MSChapv2 \
               -SplitTunneling $true -AllUserConnection -RememberCredential:$false -Force | Out-Null;",
            name = q(name),
            server = q(&p.server),
            psk = q(&p.psk),
        );
        // Route set: profile routes + the connecting host's /32 (so a fresh tunnel
        // reaches it even without a profile subnet route).
        let mut routes: Vec<String> = p
            .routes
            .iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            routes.push(if ip.is_ipv6() { format!("{host}/128") } else { format!("{host}/32") });
        }
        for r in &routes {
            inner.push_str(&format!(
                "Add-VpnConnectionRoute -ConnectionName '{name}' -DestinationPrefix '{r}' \
                   -AllUserConnection -ErrorAction SilentlyContinue | Out-Null;",
                name = q(name),
                r = q(r)
            ));
        }
        run_elevated(&inner).await?;

        // Connect. rasdial (no admin — IKEEXT does the IPsec) blocks until connected
        // or failed and prints an error code we translate. Password on argv is
        // unavoidable for rasdial; it's a short-lived hidden child.
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

    pub async fn disconnect(name: &str) {
        // Just drop the link (no admin). We keep the phonebook entry — a fresh
        // connect re-runs the elevated setup with -Force, refreshing PSK/routes.
        let _ = ps(&format!("rasdial '{}' /disconnect", q(name))).await;
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
            "the server didn't respond (error 809) — L2TP/IPsec behind NAT. We applied the \
             Windows NAT-T registry fix (AssumeUDPEncapsulationContextOnSendRule = 2) during \
             setup, but it needs a REBOOT to take effect — reboot and retry. Also ensure UDP \
             500/4500 are open to the server".into()
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

// ── Linux implementation (NetworkManager + NetworkManager-l2tp via nmcli) ─────
//
// No userspace L2TP/IPsec exists, so — like Windows — we drive the OS stack. On
// Linux that's NetworkManager with the NetworkManager-l2tp plugin (which wraps
// strongSwan/libreswan + xl2tpd + pppd). We create a VPN connection with nmcli
// (split-tunnel: ipv4.never-default + explicit routes), store the secrets, and
// bring it up. Requires the plugin installed (EPEL on RHEL/Rocky) and polkit
// authorisation for the current user to control networking.

#[cfg(target_os = "linux")]
mod imp {
    use super::L2tpProfile;
    use tokio::process::Command;

    const VPN_TYPE: &str = "org.freedesktop.NetworkManager.l2tp";

    async fn nmcli(args: &[&str]) -> Result<String, String> {
        let out = Command::new("nmcli")
            .args(args)
            .output()
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "nmcli not found — install NetworkManager and the NetworkManager-l2tp \
                     plugin (RHEL/Rocky: enable EPEL then dnf install NetworkManager-l2tp)"
                        .to_string()
                } else {
                    format!("nmcli: {e}")
                }
            })?;
        let so = String::from_utf8_lossy(&out.stdout).to_string();
        if out.status.success() {
            Ok(so)
        } else {
            let se = String::from_utf8_lossy(&out.stderr).to_string();
            Err(format!("{}{}", so, se).trim().to_string())
        }
    }

    pub async fn is_connected(name: &str) -> bool {
        match nmcli(&["-t", "-f", "NAME", "con", "show", "--active"]).await {
            Ok(out) => out.lines().any(|l| l == name),
            Err(_) => false,
        }
    }

    /// True if an nmcli error means the NetworkManager-l2tp plugin isn't installed.
    fn is_plugin_missing(e: &str) -> bool {
        let l = e.to_lowercase();
        l.contains("was not installed")
            || l.contains("not installed")
            || l.contains("vpn-type")
            || l.contains("not supported")
            || (l.contains("unknown") && l.contains("vpn"))
            || e.contains(VPN_TYPE)
    }

    /// Install the NetworkManager-l2tp plugin via pkexec (a polkit password
    /// dialog, the Linux equivalent of Windows' UAC) — the user asked the client
    /// to do this instead of running dnf by hand. Detects the distro package
    /// manager, enables EPEL on RHEL/Rocky, installs the plugin, and reloads
    /// NetworkManager so the new VPN type registers. No user input goes into the
    /// script, so there's nothing to escape.
    async fn install_plugin() -> Result<(), String> {
        // NetworkManager-l2tp is only a plugin — it needs an IPsec daemon
        // (libreswan/strongSwan) + an L2TP daemon (xl2tpd). On RHEL/Rocky those
        // live in EPEL, and their build-deps often need the CRB/PowerTools repo
        // enabled, so we enable both before installing — the earlier failure was
        // exactly this (plugin not found / deps unresolved → nothing installed).
        const SCRIPT: &str = "set -e; \
            if command -v dnf >/dev/null 2>&1; then \
              dnf install -y epel-release dnf-plugins-core || true; \
              dnf config-manager --set-enabled crb 2>/dev/null \
                || dnf config-manager --set-enabled powertools 2>/dev/null || true; \
              dnf install -y NetworkManager-l2tp xl2tpd libreswan; \
            elif command -v apt-get >/dev/null 2>&1; then \
              apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y network-manager-l2tp; \
            elif command -v zypper >/dev/null 2>&1; then \
              zypper --non-interactive install NetworkManager-l2tp xl2tpd strongswan; \
            elif command -v pacman >/dev/null 2>&1; then \
              pacman -Sy --noconfirm networkmanager-l2tp xl2tpd strongswan; \
            else echo 'no supported package manager (install NetworkManager-l2tp manually)' >&2; exit 1; fi; \
            systemctl reload-or-restart NetworkManager 2>/dev/null || systemctl restart NetworkManager || true";
        let out = Command::new("pkexec")
            .args(["sh", "-c", SCRIPT])
            .output()
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "pkexec not found — install NetworkManager-l2tp manually (RHEL/Rocky: \
                     dnf install epel-release NetworkManager-l2tp)"
                        .to_string()
                } else {
                    format!("pkexec: {e}")
                }
            })?;
        if out.status.success() {
            // Give NetworkManager a moment to register the freshly-installed plugin.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            return Ok(());
        }
        // pkexec exit 126 = user dismissed/failed the polkit auth; 127 = not authorised.
        let code = out.status.code().unwrap_or(-1);
        let se = String::from_utf8_lossy(&out.stderr);
        if code == 126 || code == 127 {
            Err("administrator authorisation was declined — can't install the \
                 NetworkManager-l2tp plugin"
                .into())
        } else {
            Err(format!("failed to install NetworkManager-l2tp: {}", se.trim()))
        }
    }

    pub async fn connect(p: &L2tpProfile, password: &str, name: &str, host: &str) -> Result<(), String> {
        // Recreate idempotently: drop any stale connection of the same name first.
        let _ = nmcli(&["con", "delete", name]).await;

        // Create the L2TP VPN connection. NB: `con add` SUCCEEDS even without the
        // plugin — NetworkManager only needs it at ACTIVATION, so the plugin-missing
        // check + auto-install happen at `con up` below, not here.
        let add = &["con", "add", "type", "vpn", "con-name", name, "ifname", "*", "vpn-type", VPN_TYPE];
        nmcli(add).await?;

        // vpn.data: gateway + user + IPsec on + the PSK. NB: the IPsec PSK goes in
        // vpn.DATA (not vpn.secrets) for NetworkManager-l2tp — that's the canonical
        // layout; putting it in secrets left the connection unable to negotiate.
        // password-flags=0 = the PPP password is stored (in vpn.secrets below), so
        // activation doesn't hang waiting for an agent.
        let vpn_data = format!(
            "gateway = {server}, user = {user}, ipsec-enabled = yes, \
             ipsec-psk = {psk}, password-flags = 0",
            server = p.server.trim(),
            user = p.username.trim(),
            psk = p.psk,
        );
        nmcli(&["con", "modify", name, "vpn.data", &vpn_data]).await?;
        nmcli(&["con", "modify", name, "vpn.secrets", &format!("password = {password}")]).await?;

        // Split-tunnel: never the default route; only the host /32 + profile routes.
        nmcli(&["con", "modify", name, "ipv4.never-default", "yes"]).await?;
        let mut routes: Vec<String> = p
            .routes
            .iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            routes.push(if ip.is_ipv6() { format!("{host}/128") } else { format!("{host}/32") });
        }
        if !routes.is_empty() {
            nmcli(&["con", "modify", name, "ipv4.routes", &routes.join(", ")]).await?;
        }

        // Bring it up. The plugin-missing error ("The VPN service '…l2tp' was not
        // installed") surfaces HERE (activation), not at con add — so this is where
        // we auto-install via pkexec and retry. May also need polkit auth to start.
        if let Err(e) = nmcli(&["con", "up", name]).await {
            if is_plugin_missing(&e) {
                install_plugin().await?;
                nmcli(&["con", "up", name])
                    .await
                    .map_err(|e2| {
                        if is_plugin_missing(&e2) {
                            "NetworkManager-l2tp was installed but NetworkManager hasn't picked it \
                             up — restart NetworkManager (or reboot) and retry".to_string()
                        } else {
                            translate_up_error(&e2)
                        }
                    })?;
            } else {
                return Err(translate_up_error(&e));
            }
        }
        Ok(())
    }

    fn translate_up_error(e: &str) -> String {
        let l = e.to_lowercase();
        if l.contains("not authorized") || l.contains("authoriz") {
            format!("not authorised to start the VPN — your user needs polkit permission to \
                     control NetworkManager. ({e})")
        } else if l.contains("password") || l.contains("secret") || l.contains("login") {
            format!("L2TP authentication failed — check the username/password/PSK. ({e})")
        } else {
            format!("L2TP connect failed: {e}")
        }
    }

    pub async fn disconnect(name: &str) {
        let _ = nmcli(&["con", "down", name]).await;
        // Remove the connection so a fresh connect re-applies edited PSK/routes.
        let _ = nmcli(&["con", "delete", name]).await;
    }
}

#[cfg(any(windows, target_os = "linux"))]
async fn connect(p: &L2tpProfile, password: &str, name: &str, host: &str) -> Result<(), String> {
    imp::connect(p, password, name, host).await
}
#[cfg(any(windows, target_os = "linux"))]
async fn disconnect(name: &str) {
    imp::disconnect(name).await
}
#[cfg(any(windows, target_os = "linux"))]
async fn is_connected(name: &str) -> bool {
    imp::is_connected(name).await
}

// ── Other platforms (macOS): not implemented yet. ────────────────────────────

#[cfg(not(any(windows, target_os = "linux")))]
async fn connect(_p: &L2tpProfile, _password: &str, _name: &str, _host: &str) -> Result<(), String> {
    Err("System L2TP/IPsec is not supported on this platform yet".into())
}
#[cfg(not(any(windows, target_os = "linux")))]
async fn disconnect(_name: &str) {}
#[cfg(not(any(windows, target_os = "linux")))]
async fn is_connected(_name: &str) -> bool {
    false
}

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
