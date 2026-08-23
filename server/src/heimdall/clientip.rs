use std::net::SocketAddr;

use axum::http::HeaderMap;

/// Resolve the identity used to key per-IP rate limits.
///
/// By default this is the TCP peer address. Behind a reverse proxy every
/// request arrives from the loopback address, which would collapse every
/// per-IP limit in `config.rs` into one shared bucket — the eleventh visitor
/// to a proxied deployment would be refused a WebSocket because the whole
/// server had "used up" its ten connections. `RUNA_TRUSTED_PROXY=1` switches
/// this to the client address recorded in `X-Forwarded-For`.
///
/// The **rightmost** entry is used, never the leftmost. A conforming proxy
/// appends the address of the connection it accepted, so the last element is
/// the only one it observed itself; everything to its left was supplied by the
/// client and is trivially forged. Trusting the leftmost entry is the classic
/// way to build a rate limiter that anyone can bypass with one header, so the
/// direction of this parse is a security control, not a detail.
///
/// Off by default for the same reason: with no proxy in front, an attacker
/// could otherwise send their own `X-Forwarded-For` and get a fresh bucket per
/// request. Enabling it is an explicit statement that a trusted proxy is
/// terminating connections.
///
/// The returned value is a limiter key held in memory only. It is never
/// logged and never persisted (spec §6.3).
pub fn rate_limit_key(trusted_proxy: bool, headers: &HeaderMap, peer: SocketAddr) -> String {
    if trusted_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(last) = forwarded.rsplit(',').map(str::trim).find(|s| !s.is_empty()) {
                return last.to_string();
            }
        }
    }
    peer.ip().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> SocketAddr {
        "127.0.0.1:54321".parse().unwrap()
    }

    fn headers_with(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", value.parse().unwrap());
        h
    }

    #[test]
    fn without_trusted_proxy_the_header_is_ignored() {
        let h = headers_with("1.2.3.4");
        assert_eq!(rate_limit_key(false, &h, peer()), "127.0.0.1");
    }

    #[test]
    fn trusted_proxy_uses_the_rightmost_entry() {
        // A client forged "1.2.3.4"; the proxy appended what it actually saw.
        let h = headers_with("1.2.3.4, 9.9.9.9");
        assert_eq!(rate_limit_key(true, &h, peer()), "9.9.9.9");
    }

    #[test]
    fn a_forged_header_cannot_mint_a_fresh_bucket() {
        // Every request from one real client must land in the same bucket no
        // matter what the client prepends.
        let a = rate_limit_key(true, &headers_with("evil-1, 9.9.9.9"), peer());
        let b = rate_limit_key(true, &headers_with("evil-2, 9.9.9.9"), peer());
        let c = rate_limit_key(true, &headers_with("a, b, c, 9.9.9.9"), peer());
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn single_hop_is_the_common_case() {
        assert_eq!(rate_limit_key(true, &headers_with("9.9.9.9"), peer()), "9.9.9.9");
    }

    #[test]
    fn falls_back_to_peer_when_header_is_absent_or_junk() {
        assert_eq!(rate_limit_key(true, &HeaderMap::new(), peer()), "127.0.0.1");
        assert_eq!(rate_limit_key(true, &headers_with(""), peer()), "127.0.0.1");
        assert_eq!(rate_limit_key(true, &headers_with(" , , "), peer()), "127.0.0.1");
    }

    #[test]
    fn ipv6_and_whitespace_survive() {
        assert_eq!(rate_limit_key(true, &headers_with("  2001:db8::1  "), peer()), "2001:db8::1");
    }
}
