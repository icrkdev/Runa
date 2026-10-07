//! The listener a Tor onion service connects to.
//!
//! Someone who reaches RÚNA through its onion address never gives it an IP
//! address: the server sees a connection from the local Tor daemon, and the
//! network sees only that they use Tor. That is the strongest answer RÚNA has
//! to "can this visit be traced back to me".
//!
//! Two things make it safe to run beside the clearnet listener:
//!
//! - **No forwarded-for header is believed here.** The clearnet side sits
//!   behind a proxy and, with `RUNA_TRUSTED_PROXY=1`, keys rate limits on
//!   `X-Forwarded-For`. Over Tor that header would be whatever the client
//!   wrote, a fresh rate-limit bucket per request. `router` strips it.
//! - **Each Tor circuit is its own client.** Without that, every onion visitor
//!   arrives from 127.0.0.1 and shares one set of limits, so any one of them
//!   could lock all the others out. Tor's `HiddenServiceExportCircuitID
//!   haproxy` prefixes each connection with a PROXY protocol v1 line naming
//!   the circuit as an address in `fc00:dead:beef:4dad::/64`; this listener
//!   reads that line and reports the circuit as the peer, and `clientip` keys
//!   that prefix per address rather than per /64. Circuits are cheap to make,
//!   which is why the deploy also turns on Tor's proof-of-work defence.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::http::HeaderName;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};

/// A PROXY v1 line is at most 107 bytes, CRLF included.
const MAX_HEADER: usize = 107;

/// How long the Tor daemon gets to send the PROXY line. It sends it at once;
/// this only bounds a connection that is not from Tor at all.
const HEADER_TIMEOUT: Duration = Duration::from_secs(2);

/// Accepts only from loopback (the local Tor daemon) and only connections
/// that open with a PROXY v1 line, whose source becomes the peer address.
pub struct TorListener {
    inner: TcpListener,
}

impl TorListener {
    pub fn new(inner: TcpListener) -> Self {
        TorListener { inner }
    }
}

impl axum::serve::Listener for TorListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        loop {
            let (mut stream, peer) = match self.inner.accept().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::debug!(error = %e, "onion listener accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            match tokio::time::timeout(HEADER_TIMEOUT, read_header_line(&mut stream)).await {
                Ok(Some(line)) => {
                    if let Some(circuit) = parse_proxy_v1(&line) {
                        return (stream, circuit);
                    }
                }
                _ => continue,
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

/// Read up to and including the first CRLF, one byte at a time so nothing of
/// the HTTP request behind it is consumed.
async fn read_header_line(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(MAX_HEADER);
    while buf.len() < MAX_HEADER {
        let b = stream.read_u8().await.ok()?;
        buf.push(b);
        if buf.ends_with(b"\r\n") {
            return String::from_utf8(buf).ok();
        }
    }
    None
}

/// `PROXY TCP6 <src> <dst> <sport> <dport>\r\n` → the source. `PROXY UNKNOWN`
/// and anything malformed are refused: a connection on this port that cannot
/// say which circuit it is would fall into a bucket shared by everyone.
pub fn parse_proxy_v1(line: &str) -> Option<SocketAddr> {
    let line = line.strip_suffix("\r\n")?;
    let mut parts = line.split(' ');
    if parts.next()? != "PROXY" {
        return None;
    }
    let family = parts.next()?;
    let src: IpAddr = parts.next()?.parse().ok()?;
    let _dst: IpAddr = parts.next()?.parse().ok()?;
    let sport: u16 = parts.next()?.parse().ok()?;
    let _dport: u16 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let family_ok = matches!((family, src), ("TCP4", IpAddr::V4(_)) | ("TCP6", IpAddr::V6(_)));
    family_ok.then(|| SocketAddr::new(src, sport))
}

/// The application, as served to the onion listener.
pub fn router(app: Router) -> Router {
    app.layer(middleware::from_fn(strip_forwarding_headers))
}

/// The clearnet application, telling Tor Browser where the onion copy is.
/// Tor Browser offers to switch when it sees this on an HTTPS page.
pub fn advertise(app: Router, onion_url: String) -> Router {
    app.layer(middleware::from_fn(move |req: axum::extract::Request, next: Next| {
        let target = format!(
            "{onion_url}{}",
            req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/")
        );
        async move {
            let mut res = next.run(req).await;
            if let Ok(v) = axum::http::HeaderValue::from_str(&target) {
                res.headers_mut().insert(HeaderName::from_static("onion-location"), v);
            }
            res
        }
    }))
}

async fn strip_forwarding_headers(mut req: axum::extract::Request, next: Next) -> Response {
    let headers = req.headers_mut();
    for name in ["x-forwarded-for", "x-real-ip", "forwarded"] {
        headers.remove(HeaderName::from_static(name));
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_circuit_tor_reports() {
        let a = parse_proxy_v1("PROXY TCP6 fc00:dead:beef:4dad::0:1a2b ::1 65535 42\r\n").unwrap();
        assert_eq!(a.ip().to_string(), "fc00:dead:beef:4dad::1a2b");
        assert_eq!(a.port(), 65535);
        let v4 = parse_proxy_v1("PROXY TCP4 192.0.2.1 127.0.0.1 5000 80\r\n").unwrap();
        assert_eq!(v4.ip().to_string(), "192.0.2.1");
    }

    #[test]
    fn refuses_anything_that_does_not_name_a_circuit() {
        for bad in [
            "PROXY UNKNOWN\r\n",
            "PROXY TCP6 fc00:dead:beef:4dad::1 ::1 1 2\n",
            "PROXY TCP4 fc00:dead:beef:4dad::1 ::1 1 2\r\n",
            "PROXY TCP6 not-an-ip ::1 1 2\r\n",
            "PROXY TCP6 fc00:dead:beef:4dad::1 ::1 1 2 extra\r\n",
            "GET / HTTP/1.1\r\n",
            "",
        ] {
            assert!(parse_proxy_v1(bad).is_none(), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn the_header_is_read_without_eating_the_request_behind_it() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut s = TcpStream::connect(addr).await.unwrap();
            s.write_all(b"PROXY TCP6 fc00:dead:beef:4dad::7 ::1 9 80\r\nGET / HTTP/1.1\r\n").await.unwrap();
            s
        });
        let mut tor = TorListener::new(listener);
        let (mut stream, peer) = axum::serve::Listener::accept(&mut tor).await;
        assert_eq!(peer.ip().to_string(), "fc00:dead:beef:4dad::7");
        let mut rest = [0u8; 16];
        stream.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"GET / HTTP/1.1\r\n");
        drop(client.await.unwrap());
    }

    #[tokio::test]
    async fn a_connection_without_the_header_is_dropped_not_served() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut plain = TcpStream::connect(addr).await.unwrap();
            plain.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
            let mut tor = TcpStream::connect(addr).await.unwrap();
            tor.write_all(b"PROXY TCP6 fc00:dead:beef:4dad::9 ::1 9 80\r\n").await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
            drop((plain, tor));
        });
        let mut tor = TorListener::new(listener);
        let (_, peer) = axum::serve::Listener::accept(&mut tor).await;
        assert_eq!(peer.ip().to_string(), "fc00:dead:beef:4dad::9", "the bare request was skipped");
    }
}
