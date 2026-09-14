use std::net::SocketAddr;

use anyhow::Result;
use runa_server::config::Config;
use runa_server::{build_router, memguard, AppState};

#[tokio::main]
async fn main() -> Result<()> {
    // Harden first — before any allocation that could hold key material —
    // but report afterwards, because the subscriber does not exist yet.
    let hardening = memguard::harden()?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "runa_server=info".into()),
        )
        .init();
    hardening.log();

    let cfg = Config::from_env();
    if cfg.trusted_proxy {
        tracing::info!(
            "RUNA_TRUSTED_PROXY=1: rate limits keyed on the last X-Forwarded-For entry. \
             Only correct behind exactly one trusted reverse proxy."
        );
    }
    let state = AppState::new(cfg.clone());

    // State the worst case out loud at boot. Rooms live only in RAM, so an
    // operator sharing this host with anything else needs the real ceiling,
    // not a set of per-unit limits they have to multiply themselves.
    tracing::info!(
        max_rooms = cfg.max_rooms,
        max_log_mib_per_room = cfg.max_log_bytes / (1024 * 1024),
        max_total_log_mib = cfg.max_total_log_bytes / (1024 * 1024),
        max_peers_per_room = cfg.max_peers_per_room,
        max_connections = cfg.max_connections,
        max_queue_kib_per_conn = cfg.max_queued_bytes_per_conn / 1024,
        "resource ceiling: retained ciphertext will not exceed max_total_log_mib \
         across all rooms; set RUNA_MAX_TOTAL_LOG_MB and RUNA_MAX_ROOMS to fit the host"
    );

    tokio::spawn(runa_server::runar::scheduler::run_scheduler(
        state.rooms.clone(),
        cfg.drain_grace,
        cfg.default_idle_ceiling,
    ));

    let app = build_router(state.clone());

    if !std::path::Path::new(&cfg.dist_dir).join("index.html").is_file() {
        tracing::warn!(
            dist = %cfg.dist_dir,
            "no index.html under RUNA_DIST — the API and websocket will work but the \
             web UI will not be served. Build it with `npm run build` in web/ and point \
             RUNA_DIST at web/dist."
        );
    }

    let addr: SocketAddr = cfg.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    if cfg.allow_insecure_ws {
        tracing::warn!("RUNA_ALLOW_INSECURE=1: plain ws:// connections will be accepted");
    }
    tracing::info!(%addr, "runa server listening");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal(state))
        .await?;
    Ok(())
}

async fn wait_for_signal() {
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
}

/// Resolves when the process should stop serving.
///
/// Rooms live only in memory, so stopping ends every one of them. With people
/// connected, the first signal warns every open room and waits out
/// `RUNA_SHUTDOWN_GRACE_SECS` so they can export. It stops early if everyone
/// leaves, and a second signal stops it at once. With nobody connected there
/// is nobody to warn, so it stops straight away.
async fn shutdown_signal(state: AppState) {
    wait_for_signal().await;
    let grace = state.cfg.shutdown_grace;
    let live = state.live_connections();
    if live == 0 || grace.is_zero() {
        tracing::info!("shutdown signal received; rooms die with the process, by design");
        return;
    }
    // Listening for the second signal starts before the countdown, so one sent
    // during it cannot be missed.
    let second = wait_for_signal();
    tokio::pin!(second);
    let rooms = state.begin_restart(grace).await;
    tracing::info!(
        connections = live,
        rooms,
        grace_secs = grace.as_secs(),
        "shutdown signal received; warned every open room. Send it again to stop now"
    );
    let deadline = tokio::time::Instant::now() + grace;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            _ = &mut second => {
                tracing::info!("second shutdown signal; stopping now");
                break;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                if state.live_connections() == 0 {
                    tracing::info!("everyone left before the restart; stopping now");
                    break;
                }
            }
        }
    }
}
