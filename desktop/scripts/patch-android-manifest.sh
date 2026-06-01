#!/usr/bin/env bash
# Post-`tauri android init` patch for the Android scaffold:
#   - REQUEST_INSTALL_PACKAGES permission so the in-app updater can hand the
#     downloaded APK to Android's PackageInstaller.
#   - A FileProvider entry + xml/file_paths.xml so the cache dir is reachable
#     via content:// URI (raw file:// URIs are blocked since Android 7).
#
# Both pieces must be idempotent — the script is allowed to run on a clean
# fresh init, or against a partially-patched tree.

set -euo pipefail

ANDROID_DIR="${1:?usage: $0 <gen/android dir>}"

MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"
RES_XML_DIR="$ANDROID_DIR/app/src/main/res/xml"
FILE_PATHS="$RES_XML_DIR/file_paths.xml"

if [ ! -f "$MANIFEST" ]; then
  echo "patch-android-manifest: $MANIFEST not found"
  exit 1
fi

mkdir -p "$RES_XML_DIR"
cat > "$FILE_PATHS" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="updates" path="updates/" />
</paths>
XML

# 1. REQUEST_INSTALL_PACKAGES — add only if absent.
if ! grep -q 'REQUEST_INSTALL_PACKAGES' "$MANIFEST"; then
  # Insert before the closing </manifest> tag.
  sed -i 's|</manifest>|    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>\n</manifest>|' "$MANIFEST"
fi

# 2. FileProvider — add inside <application>, before </application>.
if ! grep -q 'androidx.core.content.FileProvider' "$MANIFEST"; then
  # Read package name from manifest. Falls back to org.hipogas.nexussh if
  # tauri's scaffold ever stops emitting the attr (it currently does).
  PKG=$(grep -oP 'package="\K[^"]+' "$MANIFEST" || true)
  if [ -z "$PKG" ]; then
    # Newer manifests don't carry package= (it lives in build.gradle.kts now);
    # the FileProvider authorities can still use the application id which
    # Tauri's generator embeds.
    PKG=$(grep -oPm1 'applicationId\s*=\s*"\K[^"]+' "$ANDROID_DIR/app/build.gradle.kts" 2>/dev/null || echo "org.hipogas.nexussh")
  fi
  PROVIDER_XML="        <provider\n            android:name=\"androidx.core.content.FileProvider\"\n            android:authorities=\"${PKG}.fileprovider\"\n            android:exported=\"false\"\n            android:grantUriPermissions=\"true\">\n            <meta-data\n                android:name=\"android.support.FILE_PROVIDER_PATHS\"\n                android:resource=\"@xml/file_paths\"/>\n        </provider>"
  sed -i "s|</application>|${PROVIDER_XML}\n    </application>|" "$MANIFEST"
fi

echo "patch-android-manifest: ok"
