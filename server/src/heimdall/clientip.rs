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
/// An IPv6 client is keyed by its /64. That is the block one household, phone
/// or server is normally handed, so keying on the full address gave anyone
/// with IPv6 2^64 fresh buckets for every limit here — room creation, guesses
/// at a key, and connections alike.
///
/// The returned value is a pseudonym, not an address: see `pseudonym`. It is
/// held in memory only, never logged and never persisted (spec §6.3).
pub fn rate_limit_key(trusted_proxy: bool, headers: &HeaderMap, peer: SocketAddr) -> String {
    pseudonym(&client_identity(trusted_proxy, headers, peer))
}

/// The address (or IPv6 /64) a client is limited as. Never stored: only its
/// pseudonym is.
fn client_identity(trusted_proxy: bool, headers: &HeaderMap, peer: SocketAddr) -> String {
    if trusted_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(last) = forwarded.rsplit(',').map(str::trim).find(|s| !s.is_empty()) {
                return match last.parse::<std::net::IpAddr>() {
                    Ok(ip) => key_for(ip),
                    Err(_) => last.to_string(),
                };
            }
        }
    }
    key_for(peer.ip())
}

/// Every limiter table used to be keyed by the client's address in plain
/// text, so the process held a readable list of who had used it. Now each
/// table holds HMAC-SHA256(key, address), truncated to 128 bits, under a key
/// drawn when the process starts and never written anywhere. The same client
/// still maps to the same entry, so no limit changes.
///
/// What this does and does not buy, stated plainly: someone who reads the
/// tables without the key — a log line, a crash report, a partial dump —
/// learns nothing. Someone who captures the whole live process has the key
/// too, and can test any address they suspect, or try all of IPv4. That is
/// the floor for any server that has to recognise a returning client. What
/// bounds it is how long entries live: `RateLimiter::sweep` drops each one
/// about a window after its client goes quiet, and a restart draws a new key,
/// after which every earlier pseudonym is unlinkable. A client who reaches
/// RÚNA over Tor never gives it an address at all.
fn pseudonym(identity: &str) -> String {
    use hmac::{Hmac, Mac};
    static KEY: std::sync::OnceLock<zeroize::Zeroizing<[u8; 32]>> = std::sync::OnceLock::new();
    let key = KEY.get_or_init(|| {
        let mut k = zeroize::Zeroizing::new([0u8; 32]);
        getrandom::fill(k.as_mut()).expect("system RNG unavailable");
        k
    });
    let mut mac =
        <Hmac<sha2::Sha256> as Mac>::new_from_slice(key.as_ref()).expect("HMAC accepts any key length");
    mac.update(b"runa/v1/client-pseudonym\0");
    mac.update(identity.as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..16])
}

fn key_for(ip: std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(v4) => v4.to_string(),
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
    }
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
        assert_eq!(client_identity(false, &h, peer()), "127.0.0.1");
    }

    #[test]
    fn trusted_proxy_uses_the_rightmost_entry() {
        // A client forged "1.2.3.4"; the proxy appended what it actually saw.
        let h = headers_with("1.2.3.4, 9.9.9.9");
        assert_eq!(client_identity(true, &h, peer()), "9.9.9.9");
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
        assert_eq!(client_identity(true, &headers_with("9.9.9.9"), peer()), "9.9.9.9");
    }

    #[test]
    fn falls_back_to_peer_when_header_is_absent_or_junk() {
        assert_eq!(client_identity(true, &HeaderMap::new(), peer()), "127.0.0.1");
        assert_eq!(client_identity(true, &headers_with(""), peer()), "127.0.0.1");
        assert_eq!(client_identity(true, &headers_with(" , , "), peer()), "127.0.0.1");
    }

    #[test]
    fn ipv6_and_whitespace_survive() {
        assert_eq!(client_identity(true, &headers_with("  2001:db8::1  "), peer()), "2001:db8:0:0::/64");
    }

    #[test]
    fn one_ipv6_block_is_one_client_however_many_addresses_it_uses() {
        let a = rate_limit_key(true, &headers_with("2001:db8:1:2:aaaa::1"), peer());
        let b = rate_limit_key(true, &headers_with("2001:db8:1:2:ffff:ffff:ffff:ffff"), peer());
        let other = rate_limit_key(true, &headers_with("2001:db8:1:3::1"), peer());
        assert_eq!(a, b);
        assert_ne!(a, other);
        let direct: SocketAddr = "[2001:db8:1:2::9]:443".parse().unwrap();
        assert_eq!(rate_limit_key(false, &HeaderMap::new(), direct), a);
    }

    #[test]
    fn an_ipv4_client_seen_over_ipv6_is_still_itself() {
        let mapped: SocketAddr = "[::ffff:198.51.100.7]:443".parse().unwrap();
        assert_eq!(client_identity(false, &HeaderMap::new(), mapped), "198.51.100.7");
        assert_eq!(client_identity(true, &headers_with("::ffff:198.51.100.7"), peer()), "198.51.100.7");
    }

    #[test]
    fn the_key_never_contains_the_address() {
        for (h, needle) in [
            (headers_with("203.0.113.9"), "203.0.113"),
            (headers_with("2001:db8:1:2::9"), "2001:db8"),
            (headers_with("::ffff:198.51.100.7"), "198.51.100"),
        ] {
            let key = rate_limit_key(true, &h, peer());
            assert!(!key.contains(needle), "{key} leaks {needle}");
            assert_eq!(key.len(), 32, "128 bits, hex");
            assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn one_client_keeps_one_key_and_two_clients_get_two() {
        let a1 = rate_limit_key(true, &headers_with("203.0.113.9"), peer());
        let a2 = rate_limit_key(true, &headers_with("203.0.113.9"), peer());
        let b = rate_limit_key(true, &headers_with("203.0.113.10"), peer());
        assert_eq!(a1, a2, "a limit has to recognise a returning client");
        assert_ne!(a1, b);
    }

    #[test]
    fn an_unparseable_forwarded_value_is_not_kept_verbatim_either() {
        let key = rate_limit_key(true, &headers_with("not-an-ip.example"), peer());
        assert!(!key.contains("example"));
    }
}
