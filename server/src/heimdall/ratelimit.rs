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
            self.evict(&mut buckets);
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

    /// Give back `n` tokens a call took, for an attempt that turned out not to
    /// be what the limit is counting. Never beyond capacity, and a no-op for a
    /// key that is not tracked.
    ///
    /// Unlike `reset`, this cannot hand a caller more than it spent, so it is
    /// safe after any success: a caller alternating good and bad attempts is
    /// still held to the bad ones.
    pub fn refund(&self, key: &K, n: u32) {
        if let Some(b) = self.buckets.lock().unwrap().get_mut(key) {
            b.tokens = (b.tokens + n as f64).min(self.capacity);
        }
    }

    /// Forget a key, so its next call starts from a full bucket.
    ///
    /// Only for the case where the caller has proved it is not the abuser the
    /// limit exists to stop — a successful authentication, say. Anywhere else
    /// this is a bypass.
    pub fn reset(&self, key: &K) {
        self.buckets.lock().unwrap().remove(key);
    }

    /// Projected token count for a bucket at `now`, without mutating it.
    fn projected(&self, b: &Bucket, now: Instant) -> f64 {
        (b.tokens + now.duration_since(b.last).as_secs_f64() * self.refill_per_sec)
            .min(self.capacity)
    }

    /// The old sweep used a fixed one-hour cutoff. Against a limiter whose
    /// window is a minute that evicts nothing, so once the table filled —
    /// trivial for anyone with an IPv6 allocation — every subsequent call
    /// walked all `max_tracked` entries under a global lock, on every request.
    ///
    /// Evict by how full a bucket is, never by how old it is. A bucket that
    /// has refilled to capacity carries no information: forgetting it and
    /// recreating it later are the same thing. Evicting the *oldest* instead
    /// is what lets a flood of fresh keys push a throttled one out and hand it
    /// a full bucket back — the limiter would then be bypassable by anyone
    /// with addresses to spare, which is the failure this whole table exists
    /// to prevent.
    fn evict(&self, buckets: &mut HashMap<K, Bucket>) {
        let now = Instant::now();
        buckets.retain(|_, b| self.projected(b, now) < self.capacity);
        if buckets.len() < self.max_tracked {
            return;
        }
        // Still full of genuinely throttled keys. Halve the table, keeping the
        // most-throttled, so this scan cannot recur on the next call.
        let keep = self.max_tracked / 2;
        let mut ranked: Vec<(K, f64)> =
            buckets.iter().map(|(k, b)| (k.clone(), self.projected(b, now))).collect();
        ranked.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let survivors: std::collections::HashSet<K> =
            ranked.into_iter().take(keep).map(|(k, _)| k).collect();
        buckets.retain(|k, _| survivors.contains(k));
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

    #[tokio::test(start_paused = true)]
    async fn a_refund_returns_what_was_spent_and_never_more() {
        let rl: RateLimiter<u64> = RateLimiter::new(2, Duration::from_secs(60), 10_000);
        assert!(rl.check(&1));
        rl.refund(&1, 1);
        assert!(rl.check(&1));
        assert!(rl.check(&1));
        assert!(!rl.check(&1), "two tokens, however many refunds came before");
        rl.refund(&1, 5);
        assert!(rl.check(&1));
        assert!(rl.check(&1));
        assert!(!rl.check(&1), "a refund is capped at capacity");
        rl.refund(&9, 1);
        assert!(rl.check(&9), "refunding an unknown key creates nothing odd");
    }

    #[test]
    fn eviction_keeps_the_table_bounded_without_a_full_scan_per_call() {
        let rl: RateLimiter<u64> = RateLimiter::new(5, Duration::from_millis(50), 64);
        for k in 0..4096u64 {
            rl.check(&k);
        }
        assert!(
            rl.buckets.lock().unwrap().len() <= 64,
            "table must stay within max_tracked"
        );
    }

    #[test]
    fn eviction_does_not_hand_out_free_tokens_inside_the_window() {
        // The throttled key must survive a flood of fresh ones. Evicting by
        // age instead of by fullness would let an attacker with many source
        // addresses reset anybody's bucket, including their own.
        let rl: RateLimiter<u64> = RateLimiter::new(2, Duration::from_secs(600), 16);
        assert!(rl.check(&1));
        assert!(rl.check(&1));
        assert!(!rl.check(&1));
        for k in 100..4000u64 {
            rl.check(&k);
        }
        assert!(!rl.check(&1), "an evicted bucket would refill and let this through");
    }
}
