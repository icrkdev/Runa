use std::net::SocketAddr;

use anyhow::Result;
use runa_server::config::Config;
use runa_server::{build_router, memguard, AppState};

#[tokio::main]
async fn main() -> Result<()> {
    memguard::harden()?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "runa_server=info".into()),
        )
        .init();

    let cfg = Config::from_env();
    let state = AppState::new(cfg.clone());

    tokio::spawn(runa_server::runar::scheduler::run_scheduler(
        state.rooms.clone(),
        cfg.drain_grace,
        cfg.default_idle_ceiling,
    ));

    let app = build_router(state);

    let addr: SocketAddr = cfg.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    if cfg.allow_insecure_ws {
        tracing::warn!("RUNA_ALLOW_INSECURE=1: plain ws:// connections will be accepted");
    }
    tracing::info!(%addr, "runa server listening");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received; rooms die with the process, by design");
}
