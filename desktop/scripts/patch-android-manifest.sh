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

# 2b. Keep-alive foreground service — permissions + <service> + the Kotlin
#     class itself. gen/android is regenerated on every CI run, so the .kt has
#     to be (re)written here, next to MainActivity.kt. Keeps SSH sessions alive
#     when the app is backgrounded or the screen is locked (a partial wake lock
#     + a dataSync foreground service stop Android from freezing the process).
for PERM in FOREGROUND_SERVICE FOREGROUND_SERVICE_DATA_SYNC WAKE_LOCK POST_NOTIFICATIONS; do
  # The trailing quote in the grep keeps FOREGROUND_SERVICE from matching the
  # longer FOREGROUND_SERVICE_DATA_SYNC line.
  if ! grep -q "android.permission.${PERM}\"" "$MANIFEST"; then
    sed -i "s|</manifest>|    <uses-permission android:name=\"android.permission.${PERM}\"/>\n</manifest>|" "$MANIFEST"
  fi
done

if ! grep -q 'KeepAliveService' "$MANIFEST"; then
  SERVICE_XML="        <service\n            android:name=\".KeepAliveService\"\n            android:exported=\"false\"\n            android:foregroundServiceType=\"dataSync\"/>"
  sed -i "s|</application>|${SERVICE_XML}\n    </application>|" "$MANIFEST"
fi

PKG_DIR=$(dirname "$(find "$ANDROID_DIR/app/src/main/java" -name MainActivity.kt | head -1)")
if [ -n "$PKG_DIR" ] && [ -d "$PKG_DIR" ]; then
  cat > "$PKG_DIR/KeepAliveService.kt" <<'KT'
package org.hipogas.nexussh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// Foreground service that keeps an active SSH session alive while the app is
// backgrounded or the screen is locked. Started/stopped from Rust (JNI) as the
// connected-session count crosses 0<->N. See android_keepalive.rs.
class KeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nexussh:session").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        return START_STICKY
    }

    private fun startForegroundCompat() {
        val channelId = "nexussh_sessions"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(channelId) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        channelId,
                        "Active sessions",
                        NotificationManager.IMPORTANCE_LOW
                    ).apply { setShowBadge(false) }
                )
            }
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        var piFlags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags = piFlags or PendingIntent.FLAG_IMMUTABLE
        }
        val pi = PendingIntent.getActivity(this, 0, launch, piFlags)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notif = builder
            .setContentTitle("NexuSSH")
            .setContentText("SSH session active")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }

    companion object {
        private const val NOTIF_ID = 20088

        @JvmStatic
        fun start(ctx: Context) {
            val i = Intent(ctx, KeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        @JvmStatic
        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, KeepAliveService::class.java))
        }
    }
}
KT
  echo "patch-android-manifest: wrote KeepAliveService.kt to $PKG_DIR"
fi

# 2c. Biometric vault unlock — USE_BIOMETRIC permission, the androidx.biometric
#     Gradle dependency, and the Kotlin helper (Keystore + BiometricPrompt). The
#     vault's data key is wrapped by a hardware-backed, fingerprint-gated key.
if ! grep -q "android.permission.USE_BIOMETRIC\"" "$MANIFEST"; then
  sed -i 's|</manifest>|    <uses-permission android:name="android.permission.USE_BIOMETRIC"/>\n</manifest>|' "$MANIFEST"
fi

GRADLE_DEP="$ANDROID_DIR/app/build.gradle.kts"
if [ -f "$GRADLE_DEP" ] && ! grep -q "androidx.biometric:biometric" "$GRADLE_DEP"; then
  python3 - "$GRADLE_DEP" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
m = re.search(r"^dependencies\s*\{", src, re.M)
if m:
    i = m.end()
    src = src[:i] + '\n    implementation("androidx.biometric:biometric:1.1.0")' + src[i:]
    open(path, "w").write(src)
else:
    sys.stderr.write("dependencies { } block not found in build.gradle.kts\n")
PY
fi

if [ -n "$PKG_DIR" ] && [ -d "$PKG_DIR" ]; then
  cat > "$PKG_DIR/BiometricVault.kt" <<'KT'
package org.hipogas.nexussh

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Wraps the vault data key with a hardware-backed, biometric-gated Keystore key.
// The Rust side starts an op then drains poll() until it settles. status is one
// of: "idle", "pending", "ok:<payload>", "err:<message>".
object BiometricVault {
    private const val ALIAS = "nexussh_vault_biokey"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORM = "AES/GCM/NoPadding"

    @Volatile
    private var status: String = "idle"

    @JvmStatic
    fun poll(): String = status

    @JvmStatic
    fun available(ctx: Context): Boolean {
        return BiometricManager.from(ctx)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS
    }

    @JvmStatic
    fun deleteKey(ctx: Context) {
        try {
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            ks.deleteEntry(ALIAS)
        } catch (_: Exception) {
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        kg.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .build()
        )
        return kg.generateKey()
    }

    private fun promptInfo(): BiometricPrompt.PromptInfo =
        BiometricPrompt.PromptInfo.Builder()
            .setTitle("NexuSSH")
            .setSubtitle("Unlock the vault")
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build()

    @JvmStatic
    fun startEnroll(ctx: Context, dek: String) {
        status = "pending"
        try {
            val activity = ctx as FragmentActivity
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(ctx),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        try {
                            val c = result.cryptoObject!!.cipher!!
                            val ct = c.doFinal(dek.toByteArray(Charsets.UTF_8))
                            val iv = c.iv
                            val out = ByteArray(1 + iv.size + ct.size)
                            out[0] = iv.size.toByte()
                            System.arraycopy(iv, 0, out, 1, iv.size)
                            System.arraycopy(ct, 0, out, 1 + iv.size, ct.size)
                            status = "ok:" + Base64.encodeToString(out, Base64.NO_WRAP)
                        } catch (e: Exception) {
                            status = "err:" + (e.message ?: "encrypt failed")
                        }
                    }

                    override fun onAuthenticationError(code: Int, msg: CharSequence) {
                        status = "err:" + msg
                    }
                }
            )
            prompt.authenticate(promptInfo(), BiometricPrompt.CryptoObject(cipher))
        } catch (e: Exception) {
            status = "err:" + (e.message ?: "enroll failed")
        }
    }

    @JvmStatic
    fun startUnlock(ctx: Context, wrapped: String) {
        status = "pending"
        try {
            val activity = ctx as FragmentActivity
            val raw = Base64.decode(wrapped, Base64.NO_WRAP)
            val ivLen = raw[0].toInt()
            val iv = raw.copyOfRange(1, 1 + ivLen)
            val ct = raw.copyOfRange(1 + ivLen, raw.size)
            val cipher = Cipher.getInstance(TRANSFORM)
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            val key = ks.getKey(ALIAS, null) as? SecretKey
                ?: throw IllegalStateException("no biometric key")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(ctx),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        try {
                            val c = result.cryptoObject!!.cipher!!
                            val dek = String(c.doFinal(ct), Charsets.UTF_8)
                            status = "ok:" + dek
                        } catch (e: Exception) {
                            status = "err:" + (e.message ?: "decrypt failed")
                        }
                    }

                    override fun onAuthenticationError(code: Int, msg: CharSequence) {
                        status = "err:" + msg
                    }
                }
            )
            prompt.authenticate(promptInfo(), BiometricPrompt.CryptoObject(cipher))
        } catch (e: Exception) {
            status = "err:" + (e.message ?: "unlock failed")
        }
    }
}
KT
  echo "patch-android-manifest: wrote BiometricVault.kt to $PKG_DIR"
fi

# 3. Force AGP to sign debug builds with the keystore we placed in
#    `gen/android/debug.keystore`. By default AGP looks at
#    `~/.android/debug.keystore`, but on the CI runner something between
#    Tauri's gradle invocation and AGP keeps regenerating its own per-run
#    debug key — we have not been able to make it honour the pinned
#    home-dir keystore. Wiring `signingConfigs.debug` explicitly removes
#    that whole guessing game: AGP signs with exactly the file we point
#    at, every time.
GRADLE_KTS="$ANDROID_DIR/app/build.gradle.kts"
if [ -f "$GRADLE_KTS" ] && ! grep -q 'signingConfigs *{ *getByName("debug")' "$GRADLE_KTS"; then
  python3 - "$GRADLE_KTS" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
# 1) Inject a signingConfigs block as the first statement inside `android {`.
#    The same pinned keystore (gen/android/debug.keystore) signs BOTH debug and
#    release, so a single signer means existing installs update cleanly.
inject = (
    "\n    signingConfigs {\n"
    "        getByName(\"debug\") {\n"
    "            storeFile = rootProject.file(\"debug.keystore\")\n"
    "            storePassword = \"android\"\n"
    "            keyAlias = \"androiddebugkey\"\n"
    "            keyPassword = \"android\"\n"
    "        }\n"
    "        create(\"release\") {\n"
    "            storeFile = rootProject.file(\"debug.keystore\")\n"
    "            storePassword = \"android\"\n"
    "            keyAlias = \"androiddebugkey\"\n"
    "            keyPassword = \"android\"\n"
    "        }\n"
    "    }\n"
)
m = re.search(r"^android\s*\{", src, re.M)
if not m:
    sys.stderr.write("android { ... } block not found in build.gradle.kts\n")
    sys.exit(1)
i = m.end()
src = src[:i] + inject + src[i:]

# 2) Wire the release buildType to that signing config, and disable R8/minify
#    for now — minification on a Tauri/wry app risks stripping the JNI/webview
#    bridge, and we can't device-test that here. A signed, un-minified release
#    is still much smaller than the debug build and is the safe first ship.
src = src.replace(
    'getByName("release") {',
    'getByName("release") {\n'
    '            signingConfig = signingConfigs.getByName("release")',
    1,
)
src = src.replace("isMinifyEnabled = true", "isMinifyEnabled = false", 1)

open(path, "w").write(src)
PY
fi

echo "patch-android-manifest: ok"
