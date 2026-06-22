//! HTTP handlers + auth middleware for the Phase-0 account/auth/2FA/session API.

use axum::{
    extract::{ConnectInfo, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use totp_rs::{Algorithm, Secret, TOTP};

use crate::crypto;
use crate::AppState;

const SESSION_TTL_SECS: i64 = 30 * 24 * 60 * 60; // 30 days
const RECOVERY_CODE_COUNT: usize = 10;
const TOTP_ISSUER: &str = "NexuSSH";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

pub struct ApiError(StatusCode, serde_json::Value);

impl ApiError {
    pub fn new(code: StatusCode, msg: &str) -> Self {
        ApiError(code, json!({ "error": msg }))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

pub fn db_err<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!("db error: {}", e);
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

// ---------------------------------------------------------------------------
// Authenticated-user context, injected by the session middleware.
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AuthUser {
    pub user_id: String,
    #[allow(dead_code)]
    pub device_id: String,
}

/// Bearer-token session middleware. Looks up the session, checks expiry,
/// refreshes the device's last_seen, and attaches `AuthUser` to extensions.
pub async fn require_auth(
    State(state): State<AppState>,
    mut req: axum::extract::Request,
    next: Next,
) -> Response {
    let token = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string());

    let Some(token) = token else {
        return ApiError::new(StatusCode::UNAUTHORIZED, "missing bearer token").into_response();
    };

    let lookup = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT user_id, device_id, expires_at FROM sessions WHERE token = ?1",
            [&token],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
    };

    let (user_id, device_id, expires_at) = match lookup {
        Ok(Some(row)) => row,
        Ok(None) => {
            return ApiError::new(StatusCode::UNAUTHORIZED, "invalid token").into_response()
        }
        Err(e) => return db_err(e).into_response(),
    };

    if expires_at < now() {
        let conn = state.db.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM sessions WHERE token = ?1", [&token]);
        return ApiError::new(StatusCode::UNAUTHORIZED, "session expired").into_response();
    }

    {
        let conn = state.db.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE devices SET last_seen = ?1 WHERE id = ?2",
            rusqlite::params![now(), device_id],
        );
        // Sliding session: renew the expiry on use, so an ACTIVE device is not
        // logged out every 30 days from login regardless of activity (that fixed
        // 30d-from-login expiry is exactly what produced the "invalid token"
        // surprise). Only bump when it has drifted by >1 day, to avoid a write
        // on every single request.
        if expires_at - now() < SESSION_TTL_SECS - 86400 {
            let _ = conn.execute(
                "UPDATE sessions SET expires_at = ?1 WHERE token = ?2",
                rusqlite::params![now() + SESSION_TTL_SECS, &token],
            );
        }
    }

    req.extensions_mut().insert(AuthUser { user_id, device_id });
    next.run(req).await
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

pub async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RegisterReq {
    pub username: String,
    /// Client KDF output (HKDF(masterKey,"nexussh-auth")), base64. NOT stored raw.
    pub auth_hash: String,
    /// Opaque blobs stored verbatim, returned to the client at login.
    pub account_salt: String,
    pub kdf_params: String,
    pub wrapped_user_key: String,
    pub recovery_wrapped_user_key: Option<String>,
    /// Client KDF output derived from the RECOVERY key (mirror of `auth_hash`).
    /// Stored as an argon2 verifier so a no-password recovery-login can prove
    /// possession of the recovery key. Optional for back-compat.
    pub recovery_auth_hash: Option<String>,
}

#[derive(Serialize)]
pub struct RegisterResp {
    pub user_id: String,
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> ApiResult<impl IntoResponse> {
    let username = req.username.trim().to_string();
    if username.is_empty() || username.len() > 128 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid username"));
    }
    if req.auth_hash.is_empty()
        || req.account_salt.is_empty()
        || req.wrapped_user_key.is_empty()
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "missing fields"));
    }

    // Wrap the client auth_hash with a fresh random salt (server never stores it raw).
    let server_hash = crypto::hash_auth(&req.auth_hash)
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "hash error"))?;
    // Same for the recovery-key auth hash, if the client provided one.
    let recovery_hash = match req.recovery_auth_hash.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => Some(
            crypto::hash_auth(h)
                .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "hash error"))?,
        ),
        None => None,
    };
    let user_id = crypto::new_uuid();

    let conn = state.db.conn.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO users
            (id, username, server_hash, account_salt, kdf_params,
             wrapped_user_key, recovery_wrapped_user_key, recovery_hash,
             totp_secret, totp_enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0, ?9)",
        rusqlite::params![
            user_id,
            username,
            server_hash,
            req.account_salt,
            req.kdf_params,
            req.wrapped_user_key,
            req.recovery_wrapped_user_key,
            recovery_hash,
            now(),
        ],
    );

    match res {
        Ok(_) => Ok((StatusCode::CREATED, Json(RegisterResp { user_id }))),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Err(ApiError::new(StatusCode::CONFLICT, "username taken"))
        }
        Err(e) => Err(db_err(e)),
    }
}

// ---------------------------------------------------------------------------
// Prelogin: client needs account_salt + kdf_params to compute auth_hash.
// To avoid username enumeration we return deterministic dummy values for
// unknown usernames (stable per-username via HMAC-less hashing of the name).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PreloginReq {
    pub username: String,
}

#[derive(Serialize)]
pub struct PreloginResp {
    pub account_salt: String,
    pub kdf_params: String,
}

pub async fn prelogin(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<PreloginReq>,
) -> ApiResult<impl IntoResponse> {
    let username = req.username.trim().to_string();
    let rl_key = format!("prelogin|{}|{}", username, addr.ip());
    if !state.ratelimit.check(&rl_key) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limited"));
    }

    let row = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT account_salt, kdf_params FROM users WHERE username = ?1",
            [&username],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_err)?
    };

    let (account_salt, kdf_params) = match row {
        Some(v) => v,
        None => {
            // Deterministic dummy salt derived from username so repeated probes
            // get the same answer (real accounts also return a stable salt).
            let dummy_salt = crypto::hash_recovery_code(&format!("nexussh-dummy-salt|{username}"));
            let salt_b64 = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                &dummy_salt.as_bytes()[..24],
            );
            (
                salt_b64,
                json!({"alg":"argon2id","m":19456,"t":2,"p":1}).to_string(),
            )
        }
    };

    Ok(Json(PreloginResp {
        account_salt,
        kdf_params,
    }))
}

// ---------------------------------------------------------------------------
// Login: verify auth_hash, gate on TOTP, issue a session, return wrapped key.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginReq {
    pub username: String,
    pub auth_hash: String,
    pub device_name: Option<String>,
    pub totp: Option<String>,
    /// Optional one-time recovery code, used if the 2FA device is lost.
    pub recovery_code: Option<String>,
}

#[derive(Serialize)]
pub struct LoginResp {
    pub token: String,
    pub user_id: String,
    pub device_id: String,
    pub account_salt: String,
    pub kdf_params: String,
    pub wrapped_user_key: String,
    pub totp_enabled: bool,
}

struct UserRow {
    id: String,
    server_hash: String,
    account_salt: String,
    kdf_params: String,
    wrapped_user_key: String,
    totp_secret: Option<String>,
    totp_enabled: bool,
}

fn load_user_by_name(state: &AppState, username: &str) -> ApiResult<Option<UserRow>> {
    let conn = state.db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id, server_hash, account_salt, kdf_params, wrapped_user_key,
                totp_secret, totp_enabled
         FROM users WHERE username = ?1",
        [username],
        |r| {
            Ok(UserRow {
                id: r.get(0)?,
                server_hash: r.get(1)?,
                account_salt: r.get(2)?,
                kdf_params: r.get(3)?,
                wrapped_user_key: r.get(4)?,
                totp_secret: r.get(5)?,
                totp_enabled: r.get::<_, i64>(6)? != 0,
            })
        },
    )
    .optional()
    .map_err(db_err)
}

/// Build a verification-only TOTP from a stored base32 secret. The account name
/// is irrelevant for code checking, so we pass a placeholder.
fn make_totp(secret_b32: &str) -> Result<TOTP, ApiError> {
    make_totp_named(secret_b32, "user")
}

/// Build a TOTP for a specific account (used to produce the otpauth:// URL).
fn make_totp_named(secret_b32: &str, account: &str) -> Result<TOTP, ApiError> {
    let bytes = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "totp secret error"))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        bytes,
        Some(TOTP_ISSUER.to_string()),
        account.to_string(),
    )
    .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "totp init error"))
}

/// Check a recovery code: if it matches an unused stored hash, mark it used.
fn consume_recovery_code(state: &AppState, user_id: &str, code: &str) -> ApiResult<bool> {
    let target = crypto::hash_recovery_code(code);
    let conn = state.db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT code_hash FROM recovery_codes WHERE user_id = ?1 AND used = 0")
        .map_err(db_err)?;
    let hashes: Vec<String> = stmt
        .query_map([user_id], |r| r.get::<_, String>(0))
        .map_err(db_err)?
        .filter_map(|x| x.ok())
        .collect();
    drop(stmt);
    for h in hashes {
        if crypto::recovery_hash_eq(&h, &target) {
            conn.execute(
                "UPDATE recovery_codes SET used = 1 WHERE user_id = ?1 AND code_hash = ?2",
                rusqlite::params![user_id, h],
            )
            .map_err(db_err)?;
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginReq>,
) -> ApiResult<impl IntoResponse> {
    let username = req.username.trim().to_string();
    let rl_key = format!("login|{}|{}", username, addr.ip());
    if !state.ratelimit.check(&rl_key) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limited"));
    }

    let user = load_user_by_name(&state, &username)?;
    let Some(user) = user else {
        // Same generic message as a bad password to avoid enumeration.
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid credentials"));
    };

    if !crypto::verify_auth(&req.auth_hash, &user.server_hash) {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid credentials"));
    }

    // Second factor.
    if user.totp_enabled {
        let mut ok = false;
        if let Some(code) = req.totp.as_deref().filter(|c| !c.is_empty()) {
            if let Some(secret) = user.totp_secret.as_deref() {
                let totp = make_totp(secret)?;
                ok = totp.check_current(code).unwrap_or(false);
            }
        }
        if !ok {
            if let Some(rc) = req.recovery_code.as_deref().filter(|c| !c.is_empty()) {
                ok = consume_recovery_code(&state, &user.id, rc)?;
            }
        }
        if !ok {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                json!({ "totp_required": true, "error": "totp required" }),
            ));
        }
    }

    // Create/reuse a device for this name and issue a session token.
    let device_name = req
        .device_name
        .unwrap_or_else(|| "unnamed device".to_string());
    let token = crypto::random_token(32);
    let ts = now();

    let device_id = {
        let conn = state.db.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM devices WHERE user_id = ?1 AND name = ?2",
                rusqlite::params![user.id, device_name],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let device_id = match existing {
            Some(id) => {
                conn.execute(
                    "UPDATE devices SET last_seen = ?1 WHERE id = ?2",
                    rusqlite::params![ts, id],
                )
                .map_err(db_err)?;
                id
            }
            None => {
                let id = crypto::new_uuid();
                conn.execute(
                    "INSERT INTO devices (id, user_id, name, created_at, last_seen)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    rusqlite::params![id, user.id, device_name, ts],
                )
                .map_err(db_err)?;
                id
            }
        };
        conn.execute(
            "INSERT INTO sessions (token, user_id, device_id, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![token, user.id, device_id, ts, ts + SESSION_TTL_SECS],
        )
        .map_err(db_err)?;
        device_id
    };

    Ok(Json(LoginResp {
        token,
        user_id: user.id,
        device_id,
        account_salt: user.account_salt,
        kdf_params: user.kdf_params,
        wrapped_user_key: user.wrapped_user_key,
        totp_enabled: user.totp_enabled,
    }))
}

// ---------------------------------------------------------------------------
// TOTP enroll / verify / disable (all authenticated)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct TotpEnrollResp {
    pub secret: String,
    pub otpauth_url: String,
}

pub async fn totp_enroll(
    State(state): State<AppState>,
    user: axum::Extension<AuthUser>,
) -> ApiResult<impl IntoResponse> {
    let username: String = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT username FROM users WHERE id = ?1",
            [&user.user_id],
            |r| r.get(0),
        )
        .map_err(db_err)?
    };

    // Fresh random base32 secret.
    let secret = Secret::generate_secret();
    let secret_b32 = match secret.to_encoded() {
        Secret::Encoded(s) => s,
        Secret::Raw(_) => unreachable!("to_encoded always yields Encoded"),
    };
    let totp = make_totp_named(&secret_b32, &username)?;
    let otpauth_url = totp.get_url();

    // Store secret but keep totp_enabled = 0 until verified.
    {
        let conn = state.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_secret = ?1, totp_enabled = 0 WHERE id = ?2",
            rusqlite::params![secret_b32, user.user_id],
        )
        .map_err(db_err)?;
    }

    Ok(Json(TotpEnrollResp {
        secret: secret_b32,
        otpauth_url,
    }))
}

#[derive(Deserialize)]
pub struct TotpCodeReq {
    pub code: String,
}

#[derive(Serialize)]
pub struct TotpVerifyResp {
    pub totp_enabled: bool,
    pub recovery_codes: Vec<String>,
}

pub async fn totp_verify(
    State(state): State<AppState>,
    user: axum::Extension<AuthUser>,
    Json(req): Json<TotpCodeReq>,
) -> ApiResult<impl IntoResponse> {
    let secret: Option<String> = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT totp_secret FROM users WHERE id = ?1",
            [&user.user_id],
            |r| r.get(0),
        )
        .map_err(db_err)?
    };
    let Some(secret) = secret else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "no enrollment in progress"));
    };

    let totp = make_totp(&secret)?;
    if !totp.check_current(&req.code).unwrap_or(false) {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid code"));
    }

    // Generate fresh one-time recovery codes; store only their hashes.
    let codes: Vec<String> = (0..RECOVERY_CODE_COUNT)
        .map(|_| crypto::random_recovery_code())
        .collect();

    {
        let conn = state.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_enabled = 1 WHERE id = ?1",
            [&user.user_id],
        )
        .map_err(db_err)?;
        // Replace any previous codes.
        conn.execute(
            "DELETE FROM recovery_codes WHERE user_id = ?1",
            [&user.user_id],
        )
        .map_err(db_err)?;
        for c in &codes {
            conn.execute(
                "INSERT INTO recovery_codes (user_id, code_hash, used) VALUES (?1, ?2, 0)",
                rusqlite::params![user.user_id, crypto::hash_recovery_code(c)],
            )
            .map_err(db_err)?;
        }
    }

    Ok(Json(TotpVerifyResp {
        totp_enabled: true,
        recovery_codes: codes,
    }))
}

pub async fn totp_disable(
    State(state): State<AppState>,
    user: axum::Extension<AuthUser>,
    Json(req): Json<TotpCodeReq>,
) -> ApiResult<impl IntoResponse> {
    let (secret, enabled): (Option<String>, bool) = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT totp_secret, totp_enabled FROM users WHERE id = ?1",
            [&user.user_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .map_err(db_err)?
    };

    if !enabled {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "totp not enabled"));
    }
    let Some(secret) = secret else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "totp not enabled"));
    };

    let totp = make_totp(&secret)?;
    let ok_totp = totp.check_current(&req.code).unwrap_or(false);
    let ok = ok_totp || consume_recovery_code(&state, &user.user_id, &req.code)?;
    if !ok {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid code"));
    }

    {
        let conn = state.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?1",
            [&user.user_id],
        )
        .map_err(db_err)?;
        conn.execute(
            "DELETE FROM recovery_codes WHERE user_id = ?1",
            [&user.user_id],
        )
        .map_err(db_err)?;
    }

    Ok(Json(json!({ "totp_enabled": false })))
}

// ---------------------------------------------------------------------------
// Recovery-key login: prove possession of the recovery key (no password),
// get a session + the recovery-wrapped user key so the client can unwrap the
// user_key and then set a NEW password via /v1/credentials.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RecoveryLoginReq {
    pub username: String,
    pub recovery_auth_hash: String,
    pub device_name: Option<String>,
}

#[derive(Serialize)]
pub struct RecoveryLoginResp {
    pub token: String,
    pub user_id: String,
    pub account_salt: String,
    pub kdf_params: String,
    pub recovery_wrapped_user_key: String,
}

pub async fn recovery_login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<RecoveryLoginReq>,
) -> ApiResult<impl IntoResponse> {
    let username = req.username.trim().to_string();
    let rl_key = format!("recovery|{}|{}", username, addr.ip());
    if !state.ratelimit.check(&rl_key) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limited"));
    }

    // Load recovery material. Same generic 401 whether the user is absent or has
    // no recovery key configured — no enumeration / no "recovery unavailable" hint.
    let row: Option<(String, String, String, Option<String>, Option<String>)> = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, account_salt, kdf_params, recovery_hash, recovery_wrapped_user_key
             FROM users WHERE username = ?1",
            [&username],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(db_err)?
    };
    let Some((user_id, account_salt, kdf_params, Some(recovery_hash), Some(recovery_wrapped))) = row
    else {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid recovery key"));
    };
    if !crypto::verify_auth(&req.recovery_auth_hash, &recovery_hash) {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid recovery key"));
    }

    // Issue a session (mirrors login).
    let device_name = req.device_name.unwrap_or_else(|| "recovery".to_string());
    let token = crypto::random_token(32);
    let ts = now();
    {
        let conn = state.db.conn.lock().unwrap();
        let device_id = crypto::new_uuid();
        conn.execute(
            "INSERT INTO devices (id, user_id, name, created_at, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![device_id, user_id, device_name, ts],
        )
        .map_err(db_err)?;
        conn.execute(
            "INSERT INTO sessions (token, user_id, device_id, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![token, user_id, device_id, ts, ts + SESSION_TTL_SECS],
        )
        .map_err(db_err)?;
    }

    Ok(Json(RecoveryLoginResp {
        token,
        user_id,
        account_salt,
        kdf_params,
        recovery_wrapped_user_key: recovery_wrapped,
    }))
}

// ---------------------------------------------------------------------------
// Update credentials (authenticated): re-key the account. Used by BOTH change-
// password (logged in normally) and recovery-finish (logged in via recovery).
// Rotates the password verifier + wrapped user key; optionally the recovery key.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CredentialsReq {
    pub auth_hash: String,
    pub wrapped_user_key: String,
    pub recovery_auth_hash: Option<String>,
    pub recovery_wrapped_user_key: Option<String>,
}

pub async fn update_credentials(
    State(state): State<AppState>,
    user: axum::Extension<AuthUser>,
    Json(req): Json<CredentialsReq>,
) -> ApiResult<impl IntoResponse> {
    if req.auth_hash.is_empty() || req.wrapped_user_key.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "missing fields"));
    }
    let server_hash = crypto::hash_auth(&req.auth_hash)
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "hash error"))?;
    let recovery_hash = match req.recovery_auth_hash.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => Some(
            crypto::hash_auth(h)
                .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "hash error"))?,
        ),
        None => None,
    };

    let conn = state.db.conn.lock().unwrap();
    if recovery_hash.is_some() {
        conn.execute(
            "UPDATE users SET server_hash=?1, wrapped_user_key=?2,
                 recovery_hash=?3, recovery_wrapped_user_key=?4 WHERE id=?5",
            rusqlite::params![
                server_hash,
                req.wrapped_user_key,
                recovery_hash,
                req.recovery_wrapped_user_key,
                user.user_id,
            ],
        )
        .map_err(db_err)?;
    } else {
        conn.execute(
            "UPDATE users SET server_hash=?1, wrapped_user_key=?2 WHERE id=?3",
            rusqlite::params![server_hash, req.wrapped_user_key, user.user_id],
        )
        .map_err(db_err)?;
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Delete account (authenticated): wipe the user and ALL their data from the
// server. Irreversible. Local hosts on the client are untouched (the client
// only clears its own sync bookkeeping).
// ---------------------------------------------------------------------------

pub async fn delete_account(
    State(state): State<AppState>,
    user: axum::Extension<AuthUser>,
) -> ApiResult<impl IntoResponse> {
    let conn = state.db.conn.lock().unwrap();
    let uid = &user.user_id;
    for sql in [
        "DELETE FROM items WHERE user_id = ?1",
        "DELETE FROM user_rev WHERE user_id = ?1",
        "DELETE FROM sessions WHERE user_id = ?1",
        "DELETE FROM devices WHERE user_id = ?1",
        "DELETE FROM recovery_codes WHERE user_id = ?1",
        "DELETE FROM users WHERE id = ?1",
    ] {
        conn.execute(sql, rusqlite::params![uid]).map_err(db_err)?;
    }
    Ok(Json(json!({ "ok": true })))
}
