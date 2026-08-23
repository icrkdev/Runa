use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Bucket {
    tokens: f64,
    last: Instant,
}

pub struct RateLimiter<K: Eq + Hash + Clone> {
    buckets: Mutex<HashMap<K, Bucket>>,
    capacity: f64,
    refill_per_sec: f64,
    max_tracked: usize,
}

impl<K: Eq + Hash + Clone> RateLimiter<K> {
    pub fn new(capacity: u32, window: Duration, max_tracked: usize) -> Self {
        let cap = capacity as f64;
        RateLimiter {
            buckets: Mutex::new(HashMap::new()),
            capacity: cap,
            refill_per_sec: cap / window.as_secs_f64().max(0.001),
            max_tracked,
        }
    }

    pub fn check(&self, key: &K) -> bool {
        self.check_n(key, 1)
    }

    pub fn check_n(&self, key: &K, n: u32) -> bool {
        let mut buckets = self.buckets.lock().unwrap();
        if buckets.len() >= self.max_tracked {
            let cutoff = Instant::now() - Duration::from_secs(3600);
            buckets.retain(|_, b| b.last > cutoff);
        }
        let now = Instant::now();
        let b = buckets.entry(key.clone()).or_insert(Bucket {
            tokens: self.capacity,
            last: now,
        });
        let elapsed = now.duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        b.last = now;
        if b.tokens >= n as f64 {
            b.tokens -= n as f64;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct AuthWindows {
    hits: std::collections::VecDeque<Instant>,
}

pub struct AuthGuard {
    pub max_per_min: u32,
    pub lockout: Duration,
    inner: Mutex<AuthWindows>,
}

impl AuthGuard {
    pub fn new(max_per_min: u32, lockout: Duration) -> Self {
        AuthGuard {
            max_per_min,
            lockout,
            inner: Mutex::new(AuthWindows {
                hits: std::collections::VecDeque::new(),
            }),
        }
    }

    pub fn allow(&self) -> bool {
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        let cutoff = now - Duration::from_secs(60);
        while g.hits.front().is_some_and(|t| *t < cutoff) {
            g.hits.pop_front();
        }
        if g.hits.len() >= self.max_per_min as usize {
            false
        } else {
            g.hits.push_back(now);
            true
        }
    }

    pub fn record_failure(&self) -> Duration {
        let g = self.inner.lock().unwrap();
        let n = g.hits.len() as u32;
        let backoff = self
            .lockout
            .mul_f64((n.saturating_sub(1)) as f64)
            .min(self.lockout * 30);
        backoff.max(Duration::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bucket_refills_over_time() {
        let rl: RateLimiter<String> = RateLimiter::new(2, Duration::from_millis(200), 10_000);
        assert!(rl.check(&"a".into()));
        assert!(rl.check(&"a".into()));
        assert!(!rl.check(&"a".into()));
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(rl.check(&"a".into()));
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(rl.check(&"a".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn distinct_keys_isolated() {
        let rl: RateLimiter<u64> = RateLimiter::new(1, Duration::from_secs(60), 10_000);
        assert!(rl.check(&1));
        assert!(!rl.check(&1));
        assert!(rl.check(&2));
    }

    #[test]
    fn auth_guard_blocks_after_max() {
        let g = AuthGuard::new(5, Duration::from_secs(30));
        for _ in 0..5 {
            assert!(g.allow());
        }
        assert!(!g.allow());
        let backoff = g.record_failure();
        assert!(backoff >= Duration::from_secs(30));
    }
}
