#!/usr/bin/env bash
# Fetch the xray-core sidecar for the host target triple into ../binaries/.
# Used for local `tauri build`/`tauri dev`; CI fetches per-platform separately.
set -euo pipefail
cd "$(dirname "$0")/../binaries"

triple="$(rustc -vV | sed -n 's/host: //p')"
case "$triple" in
  *windows*)            asset=Xray-windows-64.zip;        bin=xray.exe ;;
  aarch64-apple-*)      asset=Xray-macos-arm64-v8a.zip;   bin=xray ;;
  *apple-*)             asset=Xray-macos-64.zip;          bin=xray ;;
  aarch64*linux*)       asset=Xray-linux-arm64-v8a.zip;   bin=xray ;;
  *linux*)              asset=Xray-linux-64.zip;          bin=xray ;;
  *) echo "no xray asset mapping for $triple" >&2; exit 1 ;;
esac

out="xray-$triple"
[ "$bin" = "xray.exe" ] && out="$out.exe"

curl -fSL -o xray.zip "https://github.com/XTLS/Xray-core/releases/latest/download/$asset"
unzip -o xray.zip "$bin"
mv -f "$bin" "$out"
chmod +x "$out"
rm -f xray.zip geoip.dat geosite.dat 2>/dev/null || true
echo "fetched $out"
