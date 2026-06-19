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

  // IMPORTANT: the gesture-bound methods (execCommand, navigator.clipboard) must
  // be invoked SYNCHRONOUSLY while the user-activation is still live — i.e.
  // BEFORE the first `await`. The Tauri plugin's readback "match" is a FALSE
  // POSITIVE on Android (it echoes its own internal store, which is NOT the
  // system clipboard), so we never trust it to skip the real system writes.

  // C) Legacy hidden-textarea + execCommand('copy') — the most reliable WebView
  //    path to the SYSTEM clipboard. Runs first, synchronously, in-gesture.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", ""); // avoid popping the soft keyboard
    ta.style.position = "fixed";
    ta.style.left = "0";
    ta.style.top = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    out.push(`C:execCommand=${ok}`);
  } catch (e) {
    out.push(`C:execCommand ERR=${String(e).slice(0, 60)}`);
  }

  // B) Web Clipboard API — also initiated in-gesture (don't await before it).
  let navPromise: Promise<void> | null = null;
  try {
    navPromise = navigator.clipboard.writeText(text);
  } catch (e) {
    out.push(`B:navigator-call ERR=${String(e).slice(0, 60)}`);
  }

  // A) Tauri clipboard-manager plugin (async import → safe to await now).
  if (HAS_TAURI) {
    try {
      const { writeText, readText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      await writeText(text);
      const rb = (await readText().catch(() => "")) ?? "";
      out.push(`A:plugin write=OK readback=${rb.length}`);
    } catch (e) {
      out.push(`A:plugin ERR=${String(e).slice(0, 80)}`);
    }
  } else {
    out.push("A:skip(no-tauri)");
  }

  if (navPromise) {
    try {
      await navPromise;
      out.push("B:navigator=OK");
    } catch (e) {
      out.push(`B:navigator ERR=${String(e).slice(0, 60)}`);
    }
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
