//! Binary entrypoint for the NexuSSH sync server.
//!
//! Config via env:
//!   NEXUSSH_SYNC_BIND  (default 127.0.0.1:8787)
//!   NEXUSSH_SYNC_DB    (default ./sync.db)
//!
//! Listens on a high port behind nginx (TLS terminated by nginx).

use std::net::SocketAddr;

use nexussh_sync_server::{app, build_state};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let bind = std::env::var("NEXUSSH_SYNC_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let db_path = std::env::var("NEXUSSH_SYNC_DB").unwrap_or_else(|_| "./sync.db".to_string());

    let state = build_state(&db_path).expect("failed to open/init database");
    let router = app(state);

    let addr: SocketAddr = bind.parse().expect("invalid NEXUSSH_SYNC_BIND address");
    tracing::info!("nexussh-sync-server listening on {} (db: {})", addr, db_path);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    // into_make_service_with_connect_info gives handlers ConnectInfo<SocketAddr>
    // for per-IP rate limiting.
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("server error");
}
