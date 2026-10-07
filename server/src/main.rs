use std::net::SocketAddr;

use anyhow::Result;
use runa_server::config::Config;
use axum::serve::ListenerExt;
use runa_server::bifrost::onion;
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
    match (&cfg.restart_key, std::env::var("RUNA_RESTART_KEY").is_ok()) {
        (Some(_), _) => tracing::info!("restart key set: rooms open at a restart are handed over to the next process"),
        (None, true) => tracing::error!(
            "RUNA_RESTART_KEY is set but is not 64 hex characters; ignoring it, so a restart will end every open room"
        ),
        (None, false) => tracing::warn!("RUNA_RESTART_KEY is not set, so a restart will end every open room"),
    }
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
    tokio::spawn(state.clone().run_forgetting());

    let app = build_router(state.clone());

    if let Some(bind) = cfg.onion_bind.clone() {
        let onion_addr: SocketAddr = bind.parse()?;
        anyhow::ensure!(
            onion_addr.ip().is_loopback(),
            "RUNA_ONION_BIND must be a loopback address: only the local Tor daemon may connect"
        );
        let listener = tokio::net::TcpListener::bind(onion_addr).await?;
        let onion_app = onion::router(app.clone());
        tokio::spawn(async move {
            let listener = onion::TorListener::new(listener).tap_io(|_| {});
            if let Err(e) = axum::serve(
                listener,
                onion_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::error!(error = %e, "onion listener stopped");
            }
        });
        tracing::info!(%onion_addr, "onion listener ready: one client per Tor circuit");
    }
    let app = match cfg.onion_url.clone() {
        Some(url) => onion::advertise(app, url),
        None => app,
    };

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
/// Rooms live only in memory. With people connected, the first signal warns
/// every open room and waits out `RUNA_SHUTDOWN_GRACE_SECS`. It stops early if
/// everyone leaves, and a second signal stops it at once. Then, with a restart
/// key, every member still connected is handed a ticket for their room and
/// disconnected, and brings the room back on the next process. Without one,
/// the rooms end here. With nobody connected there is nobody to warn or hand
/// anything to, so it stops straight away.
async fn shutdown_signal(state: AppState) {
    wait_for_signal().await;
    let grace = state.cfg.shutdown_grace;
    let live = state.live_connections();
    if live == 0 {
        tracing::info!("shutdown signal received with nobody connected; stopping");
        return;
    }
    if grace.is_zero() {
        hand_over(&state).await;
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
    hand_over(&state).await;
}

/// Give out the tickets, then wait briefly for the connections they close.
async fn hand_over(state: &AppState) {
    let rooms = state.hand_over().await;
    if rooms == 0 {
        tracing::info!("stopping; the open rooms end with this process");
        return;
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while state.live_connections() > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    tracing::info!(rooms, "handed every open room a ticket to the next process; stopping");
}
