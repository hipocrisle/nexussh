// Registry of live terminal screen-readers, keyed by SSH session id.
//
// The AI features need to read the active terminal from App level, but the
// xterm `Terminal` instance lives inside <TerminalView>. Rather than thread
// refs through the tree, each TerminalView registers readers here on mount and
// drops them on unmount.

interface Readers {
  /** Last `maxLines` lines of the visible screen (trailing blanks trimmed). */
  screen: (maxLines: number) => string;
  /** The line under the cursor — i.e. the current prompt, wherever it sits on
   *  screen. Robust when a fresh session's prompt is at the TOP (nothing has
   *  scrolled yet) and the bottom rows are blank. */
  promptLine: () => string;
}

const readers = new Map<string, Readers>();

export function registerTerminalReaders(sessionId: string, r: Readers): void {
  readers.set(sessionId, r);
}

export function unregisterTerminalReader(sessionId: string): void {
  readers.delete(sessionId);
}

export function readTerminalScreen(
  sessionId: string | null | undefined,
  maxLines = 40,
): string {
  if (!sessionId) return "";
  const r = readers.get(sessionId);
  if (!r) return "";
  try {
    return r.screen(maxLines);
  } catch {
    return "";
  }
}

/** Current prompt line (under cursor) of the given session, or "". */
export function readTerminalPromptLine(sessionId: string | null | undefined): string {
  if (!sessionId) return "";
  const r = readers.get(sessionId);
  if (!r) return "";
  try {
    return r.promptLine();
  } catch {
    return "";
  }
}
