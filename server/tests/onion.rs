//! The onion listener, end to end through the real router: what a Tor
//! visitor can and cannot do to the rate limits everyone else depends on.

use std::net::SocketAddr;
use std::time::Duration;

use axum::serve::ListenerExt;
use runa_server::bifrost::onion;
use runa_server::build_router;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn cfg() -> runa_server::config::Config {
    runa_server::config::Config {
        auth_floor: Duration::from_millis(10),
        dist_dir: "/nonexistent".into(),
        // As in production behind Caddy: the clearnet side believes
        // X-Forwarded-For. The onion side must not.
        trusted_proxy: true,
        name_lookups_per_ip_per_min: 2,
        name_lookups_global_per_min: 10_000,
        ..Default::default()
    }
}

async fn spawn_onion() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = onion::router(build_router(runa_server::AppState::new(cfg())));
    tokio::spawn(async move {
        let listener = onion::TorListener::new(listener).tap_io(|_| {});
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    addr
}

/// One request as the Tor daemon delivers it: a PROXY line naming the
/// circuit, then the visitor's HTTP request, headers and all.
async fn via_tor(addr: SocketAddr, circuit: &str, request: &str) -> String {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("PROXY TCP6 {circuit} ::1 4000 80\r\n{request}").as_bytes()).await.unwrap();
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(5), s.read_to_string(&mut out)).await.unwrap().unwrap();
    out
}

async fn resolve(addr: SocketAddr, circuit: &str, forged: Option<&str>) -> u16 {
    let body = r#"{"name":"copper-lantern"}"#;
    let xff = forged.map(|v| format!("X-Forwarded-For: {v}\r\n")).unwrap_or_default();
    let req = format!(
        "POST /api/names/resolve HTTP/1.1\r\nHost: x.onion\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n{xff}Connection: close\r\n\r\n{body}",
        body.len()
    );
    let res = via_tor(addr, circuit, &req).await;
    res.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0)
}

#[tokio::test]
async fn a_forged_forwarded_for_buys_an_onion_visitor_nothing() {
    let addr = spawn_onion().await;
    let me = "fc00:dead:beef:4dad::a1";
    assert_ne!(resolve(addr, me, None).await, 429);
    assert_ne!(resolve(addr, me, None).await, 429);
    assert_eq!(resolve(addr, me, None).await, 429, "two a minute, then refused");
    for forged in ["203.0.113.1", "203.0.113.2", "1.1.1.1, 203.0.113.3"] {
        assert_eq!(
            resolve(addr, me, Some(forged)).await,
            429,
            "X-Forwarded-For {forged:?} must not mint a fresh bucket over Tor"
        );
    }
}

#[tokio::test]
async fn one_onion_visitor_cannot_spend_anothers_limits() {
    let addr = spawn_onion().await;
    let greedy = "fc00:dead:beef:4dad::b1";
    for _ in 0..3 {
        resolve(addr, greedy, None).await;
    }
    assert_eq!(resolve(addr, greedy, None).await, 429);
    assert_ne!(
        resolve(addr, "fc00:dead:beef:4dad::b2", None).await,
        429,
        "another circuit is another visitor"
    );
}

#[tokio::test]
async fn the_app_is_served_over_the_onion_listener() {
    let addr = spawn_onion().await;
    let res = via_tor(
        addr,
        "fc00:dead:beef:4dad::c1",
        "GET /version HTTP/1.1\r\nHost: x.onion\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(res.starts_with("HTTP/1.1 200"), "{res}");
    assert!(res.contains("\"commit\""), "{res}");
}

#[tokio::test]
async fn clearnet_pages_point_tor_browser_at_the_onion() {
    let onion_url = format!("http://{}.onion", "a".repeat(56));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = onion::advertise(build_router(runa_server::AppState::new(cfg())), onion_url.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    let res = reqwest::get(format!("http://{addr}/version?x=1")).await.unwrap();
    assert_eq!(
        res.headers().get("onion-location").and_then(|v| v.to_str().ok()),
        Some(format!("{onion_url}/version?x=1").as_str())
    );
}
