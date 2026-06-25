// Parse a raw multi-line SSH connect-failure log into a short human reason
// (+ the full log for the "Подробнее" disclosure). Design handoff step 13.

export interface ParsedError {
  /** Short, human-meaningful cause. Verbatim from the log unless a known
   *  pattern matched, in which case `causeKey` holds an i18n key to prefer. */
  reason: string;
  /** i18n key for a friendlier known-cause message (overrides `reason`). */
  causeKey?: string;
  fullLog: string;
  lineCount: number;
}

// Known causes → friendlier i18n key (see connect_err.cause_* in i18n.ts).
const CAUSES: { test: RegExp; key: string }[] = [
  { test: /os error 2/i, key: "connect_err.cause_keyfile" },
  { test: /connection refused/i, key: "connect_err.cause_refused" },
  { test: /timed out|timeout/i, key: "connect_err.cause_timeout" },
  { test: /authentication failed|auth\w*\s+fail|permission denied/i, key: "connect_err.cause_auth" },
  { test: /host key|hostkey|known[_ ]hosts/i, key: "connect_err.cause_hostkey" },
];

export function parseConnectError(raw: string): ParsedError {
  const text = (raw ?? "").trim();
  const lines = text.split("\n");
  // Prefer an ERROR line; else the last non-empty line; else the first.
  const errLine =
    lines.find((l) => /\bERROR\b/i.test(l)) ??
    [...lines].reverse().find((l) => l.trim()) ??
    lines[0] ??
    "";
  const reason =
    errLine
      .replace(/\b(log\.)?(target|module_path|file|line)="?[^"\s]*"?/g, "")
      .replace(/^\s*(ERROR|WARN|DEBUG)\s+/i, "")
      .replace(/\s{2,}/g, " ")
      .trim() || text.slice(0, 200);

  let causeKey: string | undefined;
  for (const c of CAUSES) {
    if (c.test.test(text)) {
      causeKey = c.key;
      break;
    }
  }

  return { reason, causeKey, fullLog: text, lineCount: lines.length };
}
