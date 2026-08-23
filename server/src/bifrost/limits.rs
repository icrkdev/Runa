use std::time::Duration;

use dashmap::DashMap;

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
        self.blocked
            .insert(ip.to_string(), std::time::Instant::now() + duration);
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
    fn block_expires_after_duration() {
        let g = ConnGuard::new(4, Duration::ZERO);
        g.temp_block("y", Duration::ZERO);
        assert!(g.acquire("y"), "zero-duration block expires immediately");
    }
}
