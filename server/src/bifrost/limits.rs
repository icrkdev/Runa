use std::time::Duration;

use dashmap::DashMap;

/// Block entries were only ever removed when the same address came back, so
/// the table grew for the life of the process. Anyone with a large address
/// range could turn that into a slow memory leak.
const MAX_BLOCKED: usize = 4096;

pub struct ConnGuard {
    counts: DashMap<String, usize>,
    blocked: DashMap<String, std::time::Instant>,
    max_concurrent: usize,
}

impl ConnGuard {
    pub fn new(max_concurrent: usize, _block_duration: Duration) -> Self {
        ConnGuard {
            counts: DashMap::new(),
            blocked: DashMap::new(),
            max_concurrent,
        }
    }

    pub fn acquire(&self, ip: &str) -> bool {
        if let Some(until) = self.blocked.get(ip) {
            if std::time::Instant::now() < *until {
                return false;
            }
            drop(until);
            self.blocked.remove(ip);
        }
        let mut c = self.counts.entry(ip.to_string()).or_insert(0);
        if *c >= self.max_concurrent {
            drop(c);
            return false;
        }
        *c += 1;
        true
    }

    pub fn release(&self, ip: &str) {
        if let Some(mut c) = self.counts.get_mut(ip) {
            *c = c.saturating_sub(1);
            if *c == 0 {
                drop(c);
                self.counts.remove(ip);
            }
        }
    }

    pub fn temp_block(&self, ip: &str, duration: Duration) {
        let now = std::time::Instant::now();
        if self.blocked.len() >= MAX_BLOCKED {
            self.blocked.retain(|_, until| *until > now);
        }
        if self.blocked.len() >= MAX_BLOCKED {
            return;
        }
        self.blocked.insert(ip.to_string(), now + duration);
    }

    /// Drop blocks that have run out. `acquire` clears one only when the same
    /// client returns, so a client who never came back stayed listed for the
    /// life of the process. Live counts need no sweep: `release` removes a
    /// client the moment its last connection closes.
    pub fn sweep(&self) {
        let now = std::time::Instant::now();
        self.blocked.retain(|_, until| *until > now);
    }

    #[cfg(test)]
    pub fn blocked_len(&self) -> usize {
        self.blocked.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_concurrency_and_releases() {
        let g = ConnGuard::new(2, Duration::from_secs(10));
        assert!(g.acquire("a"));
        assert!(g.acquire("a"));
        assert!(!g.acquire("a"));
        g.release("a");
        assert!(g.acquire("a"));
        assert!(g.acquire("b"));
    }

    #[test]
    fn blocked_ips_never_acquire() {
        let g = ConnGuard::new(4, Duration::from_secs(10));
        g.temp_block("x", Duration::from_secs(10));
        assert!(!g.acquire("x"));
        g.release("x");
        assert!(!g.acquire("x"));
    }

    #[test]
    fn block_table_is_bounded() {
        let g = ConnGuard::new(4, Duration::from_secs(10));
        for i in 0..(MAX_BLOCKED * 2) {
            g.temp_block(&format!("10.0.{}.{}", i / 256, i % 256), Duration::ZERO);
        }
        assert!(g.blocked_len() <= MAX_BLOCKED);
    }

    #[test]
    fn block_expires_after_duration() {
        let g = ConnGuard::new(4, Duration::ZERO);
        g.temp_block("y", Duration::ZERO);
        assert!(g.acquire("y"), "zero-duration block expires immediately");
    }

    #[test]
    fn a_sweep_forgets_expired_blocks_and_keeps_live_ones() {
        let g = ConnGuard::new(4, Duration::ZERO);
        g.temp_block("gone", Duration::ZERO);
        g.temp_block("held", Duration::from_secs(60));
        g.sweep();
        assert_eq!(g.blocked_len(), 1, "only the live block is remembered");
        assert!(!g.acquire("held"), "a sweep must not lift a live block");
    }
}
