// Redact likely secrets from terminal output before it is sent to the AI as
// context. This is a best-effort client-side scrub — the ONLY thing standing
// between a password/key on screen and Claude's API. It is intentionally
// conservative-to-aggressive on secrets and deliberately LEAVES IP addresses
// intact (they help the model reason about hosts/networks and are not a
// critical secret — user decision).
//
// Heuristics, not guarantees. The UI must still warn the user that turning on
// "AI видит экран" can leak sensitive data.

const MASK = "«скрыто»";

// PEM private-key blocks (SSH, RSA, EC, OpenSSH, PGP) — mask the whole body.
const PEM_BLOCK =
  /-----BEGIN [^-]*PRIVATE KEY[^-]*-----[\s\S]*?-----END [^-]*PRIVATE KEY[^-]*-----/g;

// key=value / key: value where the key name smells like a secret.
const KV_SECRET =
  /\b(pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|access[_-]?key|priv(?:ate)?[_-]?key|auth|bearer|credential|session)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

// Same secret keywords but WHITESPACE-separated from the value (e.g.
// `password hunter2`, `Bearer eyJ...`) — the [:=] form above misses these, so an
// on-screen credential written without a colon leaked to the AI proxy (F18/F26).
// Masks the value (erring toward over-redaction, which is the safe direction for
// an AI-context scrub). `key`/`auth` alone are too generic here, so exclude them.
const KV_SECRET_WS =
  /\b(pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|access[_-]?key|priv(?:ate)?[_-]?key|bearer|credential)\b\s+("[^"]*"|'[^']*'|\S{4,})/gi;

// A line that IS a password prompt echo (rare, but harmless to blank).
const PASSWORD_PROMPT_LINE =
  /^(.*\b(?:password|passphrase|пароль)\b\s*:).*$/gim;

// Long opaque tokens: 24+ chars of base64/hex-ish with no spaces. Excludes
// pure decimal (timestamps, PIDs) and dotted forms (IPs, versions) so we don't
// nuke useful context. Requires a mix that looks token-like.
const OPAQUE_TOKEN =
  /\b(?=[A-Za-z0-9_\-+/=]{24,}\b)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])(?=[A-Za-z0-9_\-+/=]*[0-9])[A-Za-z0-9_\-+/=]{24,}\b/g;

// JWT-ish: three base64url segments separated by dots.
const JWT = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function redactSecrets(input: string): string {
  if (!input) return "";
  let out = input;
  out = out.replace(PEM_BLOCK, `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`);
  out = out.replace(JWT, MASK);
  out = out.replace(KV_SECRET, (_m, k) => `${k}=${MASK}`);
  out = out.replace(KV_SECRET_WS, (_m, k) => `${k} ${MASK}`);
  out = out.replace(PASSWORD_PROMPT_LINE, (_m, prefix) => `${prefix} ${MASK}`);
  out = out.replace(OPAQUE_TOKEN, MASK);
  return out;
}
