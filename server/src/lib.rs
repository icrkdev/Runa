//! RÚNA server: an ephemeral, blind relay for end-to-end encrypted
//! collaborative documents. Forked from Rustpad; the operational transform
//! engine was removed and replaced with an encrypted CRDT relay.

#![deny(unsafe_code)]

pub mod bifrost;
pub mod config;
pub mod error;
pub mod gjallarhorn;
pub mod heimdall;
pub mod memguard;
pub mod runar;
pub mod surtr;

use std::sync::Arc;
use std::time::Duration;

use crate::bifrost::limits::ConnGuard;
use crate::config::Config;
use crate::heimdall::ratelimit::RateLimiter;
use crate::runar::RoomRegistry;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    /// Boot-time secret used to derive unpredictable placeholder salts for
    /// missing rooms (existence-oracle defence, spec §5.7).
    pub ghost_key: Arc<[u8; 32]>,
    pub rooms: Arc<RoomRegistry>,
    pub started_at: u64,
    pub conn_guard: Arc<ConnGuard>,
    /// Process-wide live connection count, against `cfg.max_connections`.
    pub live_conns: Arc<std::sync::atomic::AtomicUsize>,
    pub auth_per_ip: Arc<RateLimiter<String>>,
    pub rooms_created: Arc<RateLimiter<String>>,
    pub named_created: Arc<RateLimiter<String>>,
    pub name_lookup_ip: Arc<RateLimiter<String>>,
    pub name_lookup_global: Arc<RateLimiter<String>>,
}

impl AppState {
    pub fn new(cfg: Config) -> Self {
        let started_at = runar::room::unix_now();
        let ghost_key = Arc::new({
            let mut k = [0u8; 32];
            getrandom::fill(&mut k).expect("system RNG unavailable");
            k
        });
        AppState {
            cfg: Arc::new(cfg.clone()),
            ghost_key,
            rooms: Arc::new(RoomRegistry::with_limits(cfg.max_rooms, cfg.max_total_log_bytes)),
            started_at,
            conn_guard: Arc::new(ConnGuard::new(cfg.new_conns_per_ip, Duration::from_secs(300))),
            live_conns: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            auth_per_ip: Arc::new(RateLimiter::new(cfg.auth_attempts_per_ip_per_min, Duration::from_secs(60), 100_000)),
            rooms_created: Arc::new(RateLimiter::new(cfg.rooms_created_per_ip_per_hour, Duration::from_secs(3600), 100_000)),
            named_created: Arc::new(RateLimiter::new(cfg.named_rooms_created_per_ip_per_hour, Duration::from_secs(3600), 100_000)),
            name_lookup_ip: Arc::new(RateLimiter::new(cfg.name_lookups_per_ip_per_min, Duration::from_secs(60), 100_000)),
            name_lookup_global: Arc::new(RateLimiter::new(cfg.name_lookups_global_per_min, Duration::from_secs(60), 8)),
        }
    }
}

pub fn build_router(state: AppState) -> axum::Router {
    crate::bifrost::router::build_router(state)
}

pub use sha2;

