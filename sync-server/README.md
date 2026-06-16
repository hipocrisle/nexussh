# NexuSSH Sync Server — Phase 0

End-to-end-encrypted account/sync backend for NexuSSH. A single Rust (axum)
binary with SQLite storage.

**Zero-knowledge by design:** the server stores only auth *verifiers* and
*opaque ciphertext*. It never sees the master password, the derived encryption
keys, or any item plaintext. The account identifier is the **username**.

Phase 0 implements accounts, authentication, TOTP 2FA, sessions, and the full
DB schema. The per-item encrypted store (the `items` table) is created now but
its endpoints land in Phase 1.

## Build & run

```sh
cd sync-server
cargo build            # debug
cargo build --release  # production binary at target/release/nexussh-sync-server
cargo test             # integration tests (in-memory SQLite, no network)
```

Run:

```sh
NEXUSSH_SYNC_BIND=127.0.0.1:8787 \
NEXUSSH_SYNC_DB=/var/lib/nexussh/sync.db \
./target/release/nexussh-sync-server
```

It listens on a high local port; **TLS is terminated by nginx** in front of it
(e.g. `sync.hipogas.org` → `proxy_pass http://127.0.0.1:8787`). The DB and
schema are created automatically on first start.

### Environment

| Var                 | Default            | Meaning                          |
|---------------------|--------------------|----------------------------------|
| `NEXUSSH_SYNC_BIND` | `127.0.0.1:8787`   | listen address                   |
| `NEXUSSH_SYNC_DB`   | `./sync.db`        | SQLite file (`:memory:` for RAM) |
| `RUST_LOG`          | `info`             | log filter (tracing-subscriber)  |

## Crypto contract (what the client computes vs what the server stores)

All real cryptography happens on the **client**:

```
masterKey = Argon2id(password, account_salt)        # never leaves the device
auth_hash = HKDF(masterKey, "nexussh-auth")         # sent to the server at login/register
encKey    = HKDF(masterKey, ...)                     # never leaves the device
wrapped_user_key          = encrypt(userKey, encKey)            # opaque to server
recovery_wrapped_user_key = encrypt(userKey, recoveryKey)       # opaque to server (optional)
```

The server:

- **Never stores `auth_hash` raw.** On register it computes
  `server_hash = Argon2id(auth_hash, random per-user salt)` (PHC string) and
  verifies logins with argon2's constant-time PHC verify.
- Stores `account_salt`, `kdf_params`, `wrapped_user_key`, and
  `recovery_wrapped_user_key` **verbatim as opaque blobs** and returns them so
  the client can derive its keys. `wrapped_user_key` is returned **only after**
  `auth_hash` verifies (and after TOTP, if enabled).
- Stores `items.ciphertext` (Phase 1) verbatim and never decrypts it.

`account_salt` + `kdf_params` are returned pre-auth via `/v1/prelogin` (the
client needs them to compute `auth_hash`). For unknown usernames, `/v1/prelogin`
returns a deterministic dummy salt so it cannot be used to enumerate accounts.

## Endpoints (JSON over HTTP)

Public:

| Method & path        | Request body                                                                                              | Response                                                                                                           |
|----------------------|----------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| `GET  /v1/health`    | —                                                                                                        | `200 {"status":"ok"}`                                                                                               |
| `POST /v1/register`  | `{username, auth_hash, account_salt, kdf_params, wrapped_user_key, recovery_wrapped_user_key?}`           | `201 {"user_id"}` · `409` username taken · `400` bad input                                                          |
| `POST /v1/prelogin`  | `{username}`                                                                                              | `200 {"account_salt","kdf_params"}` (dummy values for unknown users) · `429` rate limited                           |
| `POST /v1/login`     | `{username, auth_hash, device_name?, totp?, recovery_code?}`                                              | `200 {"token","user_id","device_id","account_salt","kdf_params","wrapped_user_key","totp_enabled"}` · `401` (see below) · `429` |

`/v1/login` on a TOTP-enabled account, when no valid `totp`/`recovery_code` is
supplied, returns `401 {"totp_required":true}`; the client re-calls with `totp`.
A wrong `auth_hash`, an unknown username, or a bad second factor all return a
generic `401 {"error":"invalid credentials"}` (no `wrapped_user_key` leaked).

Authenticated (`Authorization: Bearer <token>`):

| Method & path           | Request body | Response                                                       |
|-------------------------|--------------|----------------------------------------------------------------|
| `POST /v1/totp/enroll`  | `{}`         | `200 {"secret","otpauth_url"}` (stores secret, `totp_enabled` stays 0) |
| `POST /v1/totp/verify`  | `{code}`     | `200 {"totp_enabled":true,"recovery_codes":[...10...]}`        |
| `POST /v1/totp/disable` | `{code}`     | `200 {"totp_enabled":false}` (accepts a TOTP code or a recovery code) |

Missing/invalid/expired tokens on authed routes → `401`.

### Sessions

`/v1/login` issues a random 32-byte (base64) bearer token with a **30-day**
expiry, bound to a device (created or reused by `device_name`). The session
middleware looks the token up, checks expiry, and refreshes the device's
`last_seen`.

### TOTP flow

1. Client logs in → gets a session token.
2. `POST /v1/totp/enroll` → server generates a fresh base32 secret, stores it
   with `totp_enabled = 0`, returns `secret` + `otpauth_url` for the QR.
3. User scans the QR; client `POST /v1/totp/verify {code}`. On a valid code the
   server sets `totp_enabled = 1` and returns 10 one-time **recovery codes**
   (only their SHA-256 hashes are stored).
4. Subsequent `/v1/login` requires a valid `totp` (or a `recovery_code`, which
   is consumed once). `/v1/totp/disable {code}` turns it back off.

### Rate limiting

`/v1/login` and `/v1/prelogin` are protected by an in-memory token-bucket
limiter keyed by `username|client-ip` (burst 5, ~1 req / 6s sustained) to slow
brute force. Over the limit → `429`.

## Security notes

- `server_hash` verified with constant-time argon2 PHC verify; recovery-code
  hashes compared in constant time (`subtle`).
- Session tokens and recovery codes generated from `OsRng`.
- Secrets are never written to logs.
- The `items.ciphertext` blobs and the wrapped keys are opaque to the server.

## SQL schema

Created on startup if absent:

```sql
CREATE TABLE users (
    id                        TEXT PRIMARY KEY,
    username                  TEXT UNIQUE NOT NULL,
    server_hash               TEXT NOT NULL,   -- Argon2id(auth_hash, server salt), PHC string
    account_salt              TEXT NOT NULL,   -- opaque (client KDF salt)
    kdf_params                TEXT NOT NULL,   -- opaque (client KDF params, JSON)
    wrapped_user_key          TEXT NOT NULL,   -- opaque ciphertext
    recovery_wrapped_user_key TEXT,            -- opaque ciphertext, optional
    totp_secret               TEXT,            -- base32, NULL until enrolled
    totp_enabled              INTEGER NOT NULL DEFAULT 0,
    created_at                INTEGER NOT NULL
);

CREATE TABLE devices (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
);

CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE recovery_codes (
    user_id   TEXT NOT NULL,
    code_hash TEXT NOT NULL,   -- SHA-256 hex of a one-time recovery code
    used      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id, code_hash)
);

-- Per-item encrypted store (endpoints in Phase 1; schema created now).
CREATE TABLE items (
    user_id    TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    type       TEXT NOT NULL,   -- host | host-password | known_host | ssh-key | setting ...
    ciphertext BLOB NOT NULL,   -- opaque, encrypted with the client's encKey
    rev        INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id, item_id)
);

-- Per-user monotonic revision source for the items table.
CREATE TABLE user_rev (
    user_id TEXT PRIMARY KEY,
    rev     INTEGER NOT NULL
);
```

## Tests

`tests/api.rs` drives the axum router directly over in-memory SQLite:

- register → prelogin → login happy path (token + `wrapped_user_key` returned)
- wrong `auth_hash` rejected (`401`, no key leaked)
- duplicate username → `409`
- prelogin for an unknown user returns a stable dummy salt (no enumeration)
- TOTP enroll → verify → login now requires TOTP; valid TOTP and a one-time
  recovery code both succeed; reused recovery code fails
- authed routes reject missing/garbage tokens
- health check

## Phase 1 (next)

Implement `items` endpoints: pull-since-rev (delta), push-with-CAS on `rev`
(using `user_rev` as the monotonic source), and tombstones (`deleted`). The
schema above is already in place.
