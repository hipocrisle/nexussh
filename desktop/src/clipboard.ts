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
