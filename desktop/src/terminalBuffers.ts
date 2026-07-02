// Registry of live terminal screen-readers, keyed by SSH session id.
//
// The AI context feature ("AI видит экран") needs to read the last N lines of
// the active terminal from App level, but the xterm `Terminal` instance lives
// inside <TerminalView>. Rather than thread refs through the tree, each
// TerminalView registers a reader here on mount and drops it on unmount; App
// asks for the active session's screen text on demand.

type Reader = (maxLines: number) => string;

const readers = new Map<string, Reader>();

export function registerTerminalReader(sessionId: string, reader: Reader): void {
  readers.set(sessionId, reader);
}

export function unregisterTerminalReader(sessionId: string): void {
  readers.delete(sessionId);
}

/** Last `maxLines` non-trailing-empty lines of the given session's screen, or
 *  "" if that session has no live terminal. */
export function readTerminalScreen(
  sessionId: string | null | undefined,
  maxLines = 40,
): string {
  if (!sessionId) return "";
  const r = readers.get(sessionId);
  if (!r) return "";
  try {
    return r(maxLines);
  } catch {
    return "";
  }
}
