//! Integration tests for the Phase-0 account/auth/2FA API.
//!
//! These drive the axum `Router` directly via `tower::ServiceExt::oneshot`
//! against an in-memory SQLite database, so no network or TLS is involved.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use nexussh_sync_server::{app, build_state, AppState};
use totp_rs::{Algorithm, Secret, TOTP};

fn test_state() -> AppState {
    build_state(":memory:").expect("init db")
}

async fn call(state: &AppState, method: &str, uri: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        // ConnectInfo extraction requires a peer address; oneshot doesn't set
        // one, so we inject it explicitly via the extension below.
        .header("content-type", "application/json");
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let mut request = req.body(Body::from(body.to_string())).unwrap();
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:9999".parse::<std::net::SocketAddr>().unwrap(),
    ));

    let resp = app(state.clone()).oneshot(request).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, val)
}

fn register_body(username: &str, auth_hash: &str) -> Value {
    json!({
        "username": username,
        "auth_hash": auth_hash,
        "account_salt": "c2FsdC1iYXNlNjQ=",
        "kdf_params": "{\"alg\":\"argon2id\",\"m\":19456,\"t\":2,\"p\":1}",
        "wrapped_user_key": "d3JhcHBlZC1rZXk=",
        "recovery_wrapped_user_key": "cmVjb3Zlcnkta2V5"
    })
}

#[tokio::test]
async fn register_prelogin_login_happy_path() {
    let state = test_state();

    // register
    let (st, body) = call(&state, "POST", "/v1/register", None,
        register_body("alice", "AUTHHASH_ALICE")).await;
    assert_eq!(st, StatusCode::CREATED, "register body: {body}");
    assert!(body["user_id"].is_string());

    // prelogin returns the opaque salt + kdf params the client needs
    let (st, body) = call(&state, "POST", "/v1/prelogin", None,
        json!({"username":"alice"})).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["account_salt"], "c2FsdC1iYXNlNjQ=");
    assert!(body["kdf_params"].is_string());

    // login with correct auth_hash → token + wrapped_user_key
    let (st, body) = call(&state, "POST", "/v1/login", None,
        json!({"username":"alice","auth_hash":"AUTHHASH_ALICE","device_name":"laptop"})).await;
    assert_eq!(st, StatusCode::OK, "login body: {body}");
    assert!(body["token"].is_string());
    assert_eq!(body["wrapped_user_key"], "d3JhcHBlZC1rZXk=");
    assert_eq!(body["totp_enabled"], false);
    assert!(body["device_id"].is_string());
}

#[tokio::test]
async fn wrong_auth_hash_rejected() {
    let state = test_state();
    let (st, _) = call(&state, "POST", "/v1/register", None,
        register_body("bob", "AUTHHASH_BOB")).await;
    assert_eq!(st, StatusCode::CREATED);

    let (st, body) = call(&state, "POST", "/v1/login", None,
        json!({"username":"bob","auth_hash":"WRONG"})).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "body: {body}");
    // login must not leak the wrapped key on a failed verify
    assert!(body["wrapped_user_key"].is_null());
}

#[tokio::test]
async fn username_taken_returns_409() {
    let state = test_state();
    let (st, _) = call(&state, "POST", "/v1/register", None,
        register_body("carol", "H1")).await;
    assert_eq!(st, StatusCode::CREATED);

    let (st, body) = call(&state, "POST", "/v1/register", None,
        register_body("carol", "H2")).await;
    assert_eq!(st, StatusCode::CONFLICT, "body: {body}");
}

#[tokio::test]
async fn prelogin_unknown_user_returns_dummy_no_enumeration() {
    let state = test_state();
    // Unknown user still returns a 200 with a (deterministic) dummy salt.
    let (st1, b1) = call(&state, "POST", "/v1/prelogin", None,
        json!({"username":"ghost"})).await;
    let (st2, b2) = call(&state, "POST", "/v1/prelogin", None,
        json!({"username":"ghost"})).await;
    assert_eq!(st1, StatusCode::OK);
    assert_eq!(st2, StatusCode::OK);
    assert!(b1["account_salt"].is_string());
    // Stable across calls so probing can't distinguish from a real account.
    assert_eq!(b1["account_salt"], b2["account_salt"]);
}

fn totp_code_for(secret_b32: &str) -> String {
    let bytes = Secret::Encoded(secret_b32.to_string()).to_bytes().unwrap();
    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        bytes,
        Some("NexuSSH".to_string()),
        "user".to_string(),
    )
    .unwrap();
    totp.generate_current().unwrap()
}

#[tokio::test]
async fn totp_enroll_verify_then_login_requires_totp() {
    let state = test_state();

    // register + login to get a session token
    let (st, _) = call(&state, "POST", "/v1/register", None,
        register_body("dave", "AUTHHASH_DAVE")).await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, login) = call(&state, "POST", "/v1/login", None,
        json!({"username":"dave","auth_hash":"AUTHHASH_DAVE"})).await;
    assert_eq!(st, StatusCode::OK);
    let token = login["token"].as_str().unwrap().to_string();

    // enroll (authed) → returns secret + otpauth_url
    let (st, enroll) = call(&state, "POST", "/v1/totp/enroll", Some(&token), json!({})).await;
    assert_eq!(st, StatusCode::OK, "enroll: {enroll}");
    let secret = enroll["secret"].as_str().unwrap().to_string();
    assert!(enroll["otpauth_url"].as_str().unwrap().starts_with("otpauth://"));

    // verify with a valid code → totp enabled + recovery codes returned
    let code = totp_code_for(&secret);
    let (st, verify) = call(&state, "POST", "/v1/totp/verify", Some(&token),
        json!({"code": code})).await;
    assert_eq!(st, StatusCode::OK, "verify: {verify}");
    assert_eq!(verify["totp_enabled"], true);
    let recovery = verify["recovery_codes"].as_array().unwrap();
    assert_eq!(recovery.len(), 10);

    // login now requires totp: without it → 401 + totp_required
    let (st, body) = call(&state, "POST", "/v1/login", None,
        json!({"username":"dave","auth_hash":"AUTHHASH_DAVE"})).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "body: {body}");
    assert_eq!(body["totp_required"], true);
    assert!(body["wrapped_user_key"].is_null());

    // login with a valid totp succeeds
    let code = totp_code_for(&secret);
    let (st, body) = call(&state, "POST", "/v1/login", None,
        json!({"username":"dave","auth_hash":"AUTHHASH_DAVE","totp":code})).await;
    assert_eq!(st, StatusCode::OK, "body: {body}");
    assert!(body["token"].is_string());

    // a recovery code also satisfies the second factor (one-time)
    let rc = recovery[0].as_str().unwrap();
    let (st, body) = call(&state, "POST", "/v1/login", None,
        json!({"username":"dave","auth_hash":"AUTHHASH_DAVE","recovery_code":rc})).await;
    assert_eq!(st, StatusCode::OK, "recovery login: {body}");
    // reusing the same recovery code must now fail
    let (st, _) = call(&state, "POST", "/v1/login", None,
        json!({"username":"dave","auth_hash":"AUTHHASH_DAVE","recovery_code":rc})).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn authed_route_requires_token() {
    let state = test_state();
    let (st, _) = call(&state, "POST", "/v1/totp/enroll", None, json!({})).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let (st, _) = call(&state, "POST", "/v1/totp/enroll", Some("garbage"), json!({})).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn health_ok() {
    let state = test_state();
    let (st, body) = call(&state, "GET", "/v1/health", None, Value::Null).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}
