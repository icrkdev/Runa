use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub dist_dir: String,
    pub allow_insecure_ws: bool,
    pub max_frame_bytes: usize,
    pub max_log_bytes: u64,
    pub max_peers_per_room: usize,
    pub drain_grace: Duration,
    pub default_idle_ceiling: Duration,
    pub auth_floor: Duration,
    pub auth_attempts_per_room_per_min: u32,
    pub auth_attempts_per_ip_per_min: u32,
    pub new_conns_per_ip: usize,
    pub frames_per_conn_per_sec: u32,
    pub bytes_per_conn_per_sec: u64,
    pub rooms_created_per_ip_per_hour: u32,
    pub named_rooms_created_per_ip_per_hour: u32,
    pub name_lookups_per_ip_per_min: u32,
    pub name_lookups_global_per_min: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind_addr: "127.0.0.1:3000".into(),
            dist_dir: "dist".into(),
            allow_insecure_ws: false,
            max_frame_bytes: 256 * 1024,
            max_log_bytes: 32 * 1024 * 1024,
            max_peers_per_room: 32,
            drain_grace: Duration::from_secs(60),
            default_idle_ceiling: Duration::from_secs(12 * 3600),
            auth_floor: Duration::from_millis(250),
            auth_attempts_per_room_per_min: 5,
            auth_attempts_per_ip_per_min: 30,
            new_conns_per_ip: 10,
            frames_per_conn_per_sec: 100,
            bytes_per_conn_per_sec: 1024 * 1024,
            rooms_created_per_ip_per_hour: 20,
            named_rooms_created_per_ip_per_hour: 5,
            name_lookups_per_ip_per_min: 20,
            name_lookups_global_per_min: 200,
        }
    }
}

fn env<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
}

impl Config {
    pub fn from_env() -> Self {
        let mut c = Config::default();
        c.bind_addr = std::env::var("RUNA_BIND").unwrap_or(c.bind_addr);
        c.dist_dir = std::env::var("RUNA_DIST").unwrap_or(c.dist_dir);
        c.allow_insecure_ws = std::env::var("RUNA_ALLOW_INSECURE").is_ok_and(|v| v == "1");
        c.max_frame_bytes = env("RUNA_MAX_FRAME", c.max_frame_bytes);
        c.max_log_bytes = env("RUNA_MAX_LOG", c.max_log_bytes);
        c.max_peers_per_room = env("RUNA_MAX_PEERS", c.max_peers_per_room);
        if let Some(secs) = std::env::var("RUNA_DRAIN_GRACE").ok().and_then(|v| v.parse().ok()) {
            c.drain_grace = Duration::from_secs(secs);
        }
        if let Some(secs) = std::env::var("RUNA_IDLE_CEILING").ok().and_then(|v| v.parse().ok()) {
            c.default_idle_ceiling = Duration::from_secs(secs);
        }
        if let Some(ms) = std::env::var("RUNA_AUTH_FLOOR_MS").ok().and_then(|v| v.parse().ok()) {
            c.auth_floor = Duration::from_millis(ms);
        }
        c.frames_per_conn_per_sec = env("RUNA_FRAME_RATE", c.frames_per_conn_per_sec);
        c.bytes_per_conn_per_sec = env("RUNA_BYTE_RATE", c.bytes_per_conn_per_sec);
        c.rooms_created_per_ip_per_hour = env("RUNA_ROOMS_PER_HR", c.rooms_created_per_ip_per_hour);
        c.named_rooms_created_per_ip_per_hour =
            env("RUNA_NAMED_PER_HR", c.named_rooms_created_per_ip_per_hour);
        c.name_lookups_per_ip_per_min =
            env("RUNA_NAME_LOOKUP_IP_MIN", c.name_lookups_per_ip_per_min);
        c.name_lookups_global_per_min =
            env("RUNA_NAME_LOOKUP_GLOBAL_MIN", c.name_lookups_global_per_min);
        c
    }
}
