//! NexuSSH end-to-end-encrypted account sync backend — Phase 0.
//!
//! The server is a "zero-knowledge" verifier + opaque blob store: it stores
//! only auth verifiers and ciphertext, and never sees the master password, the
//! derived encryption keys, or any item plaintext. See README.md and
//! `crypto.rs` for the full client/server crypto contract.

pub mod ai;
pub mod crypto;
pub mod db;
pub mod handlers;
pub mod items;
pub mod ratelimit;

use axum::{
    middleware,
    routing::{delete, get, post},
    Router,
};
use std::sync::Arc;

use db::Db;
use ratelimit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub ratelimit: Arc<RateLimiter>,
}

/// Build the full application router for a given state.
pub fn app(state: AppState) -> Router {
    // Authenticated routes (require a valid Bearer session token).
    let authed = Router::new()
        .route("/v1/totp/enroll", post(handlers::totp_enroll))
        .route("/v1/totp/verify", post(handlers::totp_verify))
        .route("/v1/totp/disable", post(handlers::totp_disable))
        .route("/v1/items", get(items::pull_items).post(items::push_items))
        .route("/v1/credentials", post(handlers::update_credentials))
        .route("/v1/account", delete(handlers::delete_account))
        .route("/v1/ai/status", get(ai::status))
        .route("/v1/ai/request", post(ai::request_access))
        .route("/v1/ai/suggest", post(ai::suggest))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            handlers::require_auth,
        ));

    // Public routes.
    Router::new()
        .route("/v1/health", get(handlers::health))
        .route("/v1/register", post(handlers::register))
        .route("/v1/prelogin", post(handlers::prelogin))
        .route("/v1/login", post(handlers::login))
        .route("/v1/recovery-login", post(handlers::recovery_login))
        // Admin (bot → server) — свой X-Admin-Token, вне Bearer-мидлвари.
        .route("/v1/ai/admin/grant", post(ai::admin_grant))
        .merge(authed)
        .with_state(state)
}

/// Construct an `AppState` from a database path, creating the schema.
pub fn build_state(db_path: &str) -> rusqlite::Result<AppState> {
    let db = Db::open(db_path)?;
    // Login: burst 5, ~1 attempt / 6s sustained. Prelogin shares the limiter
    // via distinct keys, so it gets its own buckets.
    let ratelimit = Arc::new(RateLimiter::new(5.0, 1.0 / 6.0));
    Ok(AppState { db, ratelimit })
}
