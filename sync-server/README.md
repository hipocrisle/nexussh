# NexuSSH Sync Server — Phase 0

End-to-end-encrypted account/sync backend for NexuSSH. A single Rust (axum)
binary with SQLite storage.

**Zero-knowledge by design:** the server stores only auth *verifiers* and
*opaque ciphertext*. It never sees the master password, the derived encryption
keys, or any item plaintext. The account identifier is the **username**.

Phase 0 implements accounts, authentication, TOTP 2FA, sessions, and the full
DB schema. **Phase 1** adds the per-item encrypted store endpoints
(`GET`/`POST /v1/items`): delta pull, batch push with optimistic concurrency on
`rev`, and tombstones. See **Item store (Phase 1)** below.

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
| `GET  /v1/items`        | query `?since=<rev>` | `200 {"items":[...],"latest_rev":<rev>}` — delta pull (see below) |
| `POST /v1/items`        | `{changes:[...]}`    | `200 {"results":[...],"latest_rev":<rev>}` — batch push w/ CAS · `400`/`413` on bad/oversize input |

Missing/invalid/expired tokens on authed routes → `401`.

## Item store (Phase 1)

The encrypted item store keeps each item as an opaque, client-encrypted
`ciphertext` blob plus a strictly monotonic per-user revision (`rev`). The
server never decrypts; `rev` lets devices pull only what they have not seen.

### Revisions

Every accepted write (insert, update, or tombstone) is stamped with the **next**
value of a per-user counter (`user_rev`). `rev` is therefore strictly increasing
across **all** of a user's items, not per-item. The counter is bumped inside the
same SQLite transaction as the write, via an `UPSERT ... RETURNING`, so
concurrent pushes are serialized and can never be handed the same `rev`.

### `GET /v1/items?since=<rev>`

Delta pull. Returns every item with `rev > since`, ordered by `rev` ascending.
`since=0` (the default) is a full pull. **Tombstones are included** (so other
devices learn of deletions); a tombstone has `deleted: true` and `ciphertext: ""`.

```json
{
  "items": [
    { "item_id": "h1", "type": "host", "ciphertext": "<b64>",
      "rev": 7, "updated_at": 1717000000000, "deleted": false },
    { "item_id": "h2", "type": "host", "ciphertext": "",
      "rev": 9, "updated_at": 1717000050000, "deleted": true }
  ],
  "latest_rev": 9
}
```

A page is capped at **1000 items**. `latest_rev` is the user's current
high-water mark (not just this page's max), so if a page is truncated the client
re-pulls with `since` = the highest `rev` it actually received until it catches
up to `latest_rev`.

### `POST /v1/items` (batch push with optimistic concurrency)

```json
{
  "changes": [
    { "item_id": "h1", "type": "host", "ciphertext": "<b64>",
      "updated_at": 1717000000000, "deleted": false, "base_rev": 0 }
  ]
}
```

`base_rev` is the `rev` the client last saw for that item (`0` for a new item).
Each change is resolved against the stored row (all changes apply atomically in
one per-user transaction):

- **new** — item does not exist and `base_rev == 0` → insert with a freshly
  bumped `rev` → `{ "item_id", "rev", "status": "ok" }`.
- **update** — stored `rev == base_rev` → update ciphertext/updated_at/deleted
  with a freshly bumped `rev` → `{ "item_id", "rev", "status": "ok" }`.
- **conflict** — stored `rev != base_rev` (or the item exists but the client
  sent `base_rev == 0`): the change is **not written**; the server's
  authoritative copy is echoed back so the client can resolve
  (last-writer-wins by `updated_at`) and retry:

  ```json
  { "item_id": "h1", "status": "conflict",
    "server": { "item_id", "type", "ciphertext", "rev", "updated_at", "deleted" } }
  ```

Response:

```json
{ "results": [ /* one per change, in order */ ], "latest_rev": <new max rev> }
```

**Deletion is a push with `deleted: true`** (empty ciphertext). The row is kept
as a tombstone with a bumped `rev` so other devices pull the deletion. There is
no separate delete endpoint. (Purging old tombstones is a future option.)

**Validation:** `type` must be one of the known item types
(`host`, `host-password`, `known_host`, `ssh-key`, `setting`, `folder`);
decoded `ciphertext` ≤ **1 MiB/item**; ≤ **500 changes/batch**. Violations are
rejected (`400` bad input, `413` oversize) **before** anything is written.

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
- item store: full pull empty; push new → pull-since returns them with revs;
  update with correct `base_rev` bumps the rev; stale `base_rev` → conflict that
  echoes the server version (no write); tombstone push appears in pull-since with
  `deleted:true`; rev strictly increases across pushes; pull/push without a token
  → `401`; oversize ciphertext / oversize batch / unknown type / non-base64
  ciphertext are rejected

## Phase 1 (done)

`items` endpoints implemented: pull-since-rev delta (`GET /v1/items?since=`),
batch push-with-CAS on `rev` using `user_rev` as the monotonic source
(`POST /v1/items`), and tombstones (delete = push with `deleted:true`). See the
**Item store (Phase 1)** section above for the full request/response shapes and
conflict/rev semantics.
