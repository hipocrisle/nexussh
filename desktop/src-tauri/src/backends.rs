//! On-demand VPN backend binaries.
//!
//! Each VPN profile type (openconnect now; L2TP/IPsec and others later) ships its
//! backend as statically-linked single-file binaries published to the repo's
//! rolling `backends` GitHub release, described by a sha256 manifest
//! (`backends.json`). The installer bundles NONE of them — on first use of a
//! profile of a given type the app downloads that backend into a per-user dir,
//! verifies each file's sha256, and runs it from there. So the base client stays
//! lean, no admin / system package is needed, and adding a new VPN type is just a
//! new entry in the manifest + a build job.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

// PRIMARY source is the RU self-host mirror: GitHub's release CDN
// (objects.githubusercontent.com) is throttled/blocked by ТСПУ in Russia, so a
// direct GitHub fetch fails intermittently there (`tls connection init failed:
// Resource temporarily unavailable`). This is the exact same problem the updater
// solves the same way — see updater.rs. GitHub is kept as a FALLBACK. The mirror
// (nexussh-update-mirror.sh on DE-1) serves byte-identical assets, and since the
// sha256 in backends.json is verified regardless of source, either path is safe.
const SELFHOST_MANIFEST_URL: &str = "https://upd.hipogas.org/nexussh/backends/backends.json";
const SELFHOST_ASSET_BASE: &str = "https://upd.hipogas.org/nexussh/backends/";
const GITHUB_MANIFEST_URL: &str =
    "https://github.com/hipocrisle/nexussh/releases/download/backends/backends.json";
const GITHUB_ASSET_BASE: &str = "https://github.com/hipocrisle/nexussh/releases/download/backends/";

/// Platform key as used in `backends.json` (e.g. "linux-x86_64", "windows-x86_64").
pub fn platform_key() -> String {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Local on-disk filename for a backend file. On Windows the main executable is
/// given as the bare logical name (e.g. "openconnect") and needs a `.exe` — but
/// accompanying files that already carry an extension (DLLs) are kept verbatim.
fn local_filename(name: &str) -> String {
    if cfg!(windows) && !name.contains('.') {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn backends_dir() -> std::io::Result<PathBuf> {
    let dir = crate::vpn::runtime_dir()?.join("backends");
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Path of an already-installed backend binary by logical name, or None.
pub fn installed_path(name: &str) -> Option<PathBuf> {
    let p = backends_dir().ok()?.join(local_filename(name));
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendStatus {
    pub id: String,
    /// This platform has a build in the manifest.
    pub supported: bool,
    /// All files present locally with matching sha256.
    pub installed: bool,
    pub files_total: usize,
    pub files_present: usize,
}

struct FileSpec {
    name: String,
    asset: String,
    sha256: String,
}

fn parse_files(manifest: &serde_json::Value, id: &str) -> Option<Vec<FileSpec>> {
    let plat = manifest.get(id)?.get("platforms")?.get(platform_key())?;
    let arr = plat.get("files")?.as_array()?;
    let files = arr
        .iter()
        .filter_map(|f| {
            Some(FileSpec {
                name: f.get("name")?.as_str()?.to_string(),
                asset: f.get("asset")?.as_str()?.to_string(),
                sha256: f.get("sha256")?.as_str()?.to_string(),
            })
        })
        .collect();
    Some(files)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// HTTP agent with connect + READ timeouts so a stalled download can't hang the
/// ensure forever (a body read past the initial call otherwise blocks with no
/// deadline).
fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(20))
        .timeout_read(std::time::Duration::from_secs(60))
        .user_agent("NexuSSH")
        .build()
}

/// GET a URL with a few retries. Transient TLS/connect failures (EAGAIN under
/// ТСПУ throttling — "Resource temporarily unavailable") are common on the first
/// attempt and usually clear on a retry a moment later.
fn get_with_retry(url: &str) -> Result<ureq::Response, String> {
    let mut last = String::new();
    for attempt in 0..3 {
        match http_agent().get(url).call() {
            Ok(r) => return Ok(r),
            Err(e) => {
                last = e.to_string();
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
    }
    Err(last)
}

/// Where the last successfully-fetched manifest is cached, so an already-installed
/// backend keeps working even when both live sources are unreachable.
fn cached_manifest_path() -> Option<PathBuf> {
    Some(backends_dir().ok()?.join("backends.json"))
}

/// Fetch the manifest: self-host (RU-reachable) first, GitHub as fallback, and if
/// BOTH are down fall back to the last cached copy on disk. On any live success we
/// refresh the cache. This makes "backend already installed" resilient to the
/// GitHub-in-RU flakiness that otherwise made the trust/connect flow fail at random.
fn fetch_manifest() -> Result<serde_json::Value, String> {
    let mut errs = Vec::new();
    for url in [SELFHOST_MANIFEST_URL, GITHUB_MANIFEST_URL] {
        match get_with_retry(url).and_then(|r| r.into_string().map_err(|e| e.to_string())) {
            Ok(body) => match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => {
                    if let Some(p) = cached_manifest_path() {
                        let _ = std::fs::write(&p, &body); // best-effort cache
                    }
                    return Ok(v);
                }
                Err(e) => errs.push(format!("{url}: invalid json: {e}")),
            },
            Err(e) => errs.push(format!("{url}: {e}")),
        }
    }
    // Both live sources failed — use the cached manifest if we have one.
    if let Some(p) = cached_manifest_path() {
        if let Ok(body) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                return Ok(v);
            }
        }
    }
    Err(format!("fetch backends manifest: {}", errs.join("; ")))
}

/// Write `bytes` to `path` as an executable (0755 on Unix), replacing any prior.
fn write_exec(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // Write to a temp then rename, so a crash mid-download never leaves a
    // truncated "valid-looking" binary.
    let tmp = path.with_extension("part");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, path)
}

#[allow(clippy::too_many_arguments)]
fn emit(
    app: &AppHandle,
    id: &str,
    file_idx: usize,
    file_count: usize,
    file: &str,
    bytes: u64,
    bytes_total: u64,
    phase: &str,
) {
    let _ = app.emit(
        "backend-progress",
        serde_json::json!({
            "id": id, "fileIdx": file_idx, "fileCount": file_count, "file": file,
            "bytes": bytes, "bytesTotal": bytes_total, "phase": phase
        }),
    );
}

/// Download + verify every file for backend `id` on this platform into the
/// per-user backends dir. Idempotent: files already present with a matching
/// sha256 are skipped. Returns logical-name → path. Emits `backend-progress`.
pub fn ensure_backend(app: &AppHandle, id: &str) -> Result<HashMap<String, PathBuf>, String> {
    // Always emit a terminal event so the progress overlay never gets stuck when
    // a download fails partway (the inner `?` returns early without a "done").
    let r = ensure_backend_inner(app, id);
    if r.is_err() {
        emit(app, id, 0, 0, "", 0, 0, "error");
    }
    r
}

fn ensure_backend_inner(app: &AppHandle, id: &str) -> Result<HashMap<String, PathBuf>, String> {
    let manifest = fetch_manifest()?;
    let files = parse_files(&manifest, id)
        .ok_or_else(|| format!("backend '{id}' has no build for {}", platform_key()))?;
    let dir = backends_dir().map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    let total = files.len();
    for (i, f) in files.iter().enumerate() {
        let dest = dir.join(local_filename(&f.name));
        if dest.exists() && sha256_file(&dest).ok().as_deref() == Some(f.sha256.as_str()) {
            out.insert(f.name.clone(), dest);
            continue;
        }
        emit(app, id, i, total, &f.name, 0, 0, "download");
        // Self-host first (RU-reachable), GitHub as fallback — same as the manifest.
        let mut resp = None;
        let mut derr = String::new();
        for base in [SELFHOST_ASSET_BASE, GITHUB_ASSET_BASE] {
            let url = format!("{base}{}", f.asset);
            match get_with_retry(&url) {
                Ok(r) => {
                    resp = Some(r);
                    break;
                }
                Err(e) => derr = format!("{url}: {e}"),
            }
        }
        let resp = resp.ok_or_else(|| format!("download {}: {derr}", f.asset))?;
        let bytes_total: u64 = resp
            .header("Content-Length")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        // Stream so the progress bar actually moves during the download (large
        // Windows backend is ~15 MB) instead of sitting frozen on one file.
        let mut reader = resp.into_reader();
        let mut bytes: Vec<u8> = Vec::with_capacity(bytes_total as usize);
        let mut buf = [0u8; 65536];
        let mut got_bytes: u64 = 0;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("read {}: {e}", f.asset))?;
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
            got_bytes += n as u64;
            emit(app, id, i, total, &f.name, got_bytes, bytes_total, "download");
        }
        let got = hex(&Sha256::digest(&bytes));
        if got != f.sha256 {
            return Err(format!(
                "sha256 mismatch for {} — expected {}, got {} (refusing to run)",
                f.asset, f.sha256, got
            ));
        }
        write_exec(&dest, &bytes).map_err(|e| format!("save {}: {e}", f.name))?;
        out.insert(f.name.clone(), dest);
    }
    emit(app, id, total, total, "", 0, 0, "done");
    Ok(out)
}

/// Quick local status (still fetches the manifest to know the expected file set).
#[tauri::command]
pub async fn backend_status(id: String) -> Result<BackendStatus, String> {
    tokio::task::spawn_blocking(move || {
        let manifest = fetch_manifest()?;
        match parse_files(&manifest, &id) {
            None => Ok(BackendStatus {
                id,
                supported: false,
                installed: false,
                files_total: 0,
                files_present: 0,
            }),
            Some(files) => {
                let dir = backends_dir().map_err(|e| e.to_string())?;
                let present = files
                    .iter()
                    .filter(|f| {
                        let d = dir.join(local_filename(&f.name));
                        d.exists() && sha256_file(&d).ok().as_deref() == Some(f.sha256.as_str())
                    })
                    .count();
                Ok(BackendStatus {
                    id,
                    supported: true,
                    installed: !files.is_empty() && present == files.len(),
                    files_total: files.len(),
                    files_present: present,
                })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ensure a backend is downloaded (idempotent). Emits `backend-progress`.
#[tauri::command]
pub async fn backend_ensure(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || ensure_backend(&app, &id).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encodes_lowercase() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff, 0xa5]), "000fffa5");
    }

    #[test]
    fn platform_key_shape() {
        let k = platform_key();
        assert!(k.contains('-'), "expected os-arch, got {k}");
        assert!(k.starts_with("linux") || k.starts_with("windows") || k.starts_with("macos"));
    }

    #[test]
    fn parses_manifest_for_current_platform() {
        // A manifest that includes THIS platform's key → parse_files must find it.
        let plat = platform_key();
        let manifest = serde_json::json!({
            "openconnect": { "platforms": { plat: { "invoke": "script-tun+ocproxy", "files": [
                { "name": "openconnect", "asset": "openconnect-x", "sha256": "aa" },
                { "name": "ocproxy",     "asset": "ocproxy-x",     "sha256": "bb" }
            ]}}}
        });
        let files = parse_files(&manifest, "openconnect").expect("should parse this platform");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "openconnect");
        assert_eq!(files[1].sha256, "bb");
        // unknown backend / platform → None
        assert!(parse_files(&manifest, "wireguard").is_none());
    }

    #[test]
    fn local_filename_adds_exe_on_windows_only() {
        let f = local_filename("openconnect");
        if cfg!(windows) {
            assert_eq!(f, "openconnect.exe");
            // DLLs (already have an extension) are kept verbatim, not "<name>.dll.exe".
            assert_eq!(local_filename("libgnutls-30.dll"), "libgnutls-30.dll");
        } else {
            assert_eq!(f, "openconnect");
            assert_eq!(local_filename("libgnutls-30.dll"), "libgnutls-30.dll");
        }
    }
}
