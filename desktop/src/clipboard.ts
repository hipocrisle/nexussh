// Clipboard read/write that works on Android. The WebView's
// navigator.clipboard is unreliable/blocked there (paste returned nothing on
// the APK), so inside the Tauri app we go through the clipboard-manager plugin
// and only fall back to the web API in a plain dev browser.

const HAS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function readClipboard(): Promise<string> {
  if (HAS_TAURI) {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return (await readText()) ?? "";
    } catch {
      return "";
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

// Diagnostic + robust copy: try every method, verify with a read-back, and
// return a one-line report of what happened. Returns as soon as a method is
// confirmed to have landed text in the clipboard.
export async function copyTextVerbose(text: string): Promise<string> {
  if (!text) return "copy: EMPTY text";
  const out: string[] = [`len=${text.length}`];
  // A) Tauri clipboard-manager plugin (the intended path on Android).
  if (HAS_TAURI) {
    try {
      const { writeText, readText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      await writeText(text);
      out.push("A:write=OK");
      try {
        const rb = (await readText()) ?? "";
        out.push(`A:readback len=${rb.length} match=${rb === text}`);
        if (rb === text) return out.join(" ");
      } catch (e) {
        out.push(`A:readback ERR=${String(e).slice(0, 80)}`);
      }
    } catch (e) {
      out.push(`A:write ERR=${String(e).slice(0, 80)}`);
    }
  } else {
    out.push("A:skip(no-tauri)");
  }
  // B) Web Clipboard API.
  try {
    await navigator.clipboard.writeText(text);
    out.push("B:navigator=OK");
  } catch (e) {
    out.push(`B:navigator ERR=${String(e).slice(0, 60)}`);
  }
  // C) Legacy hidden-textarea + execCommand('copy').
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    out.push(`C:execCommand=${ok}`);
  } catch (e) {
    out.push(`C:execCommand ERR=${String(e).slice(0, 60)}`);
  }
  return out.join(" ");
}

export async function writeClipboard(text: string): Promise<void> {
  if (!text) return;
  if (HAS_TAURI) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch {
      /* fall through to the web API */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable — ignore */
  }
}
