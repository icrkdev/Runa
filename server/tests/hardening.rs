//! Regression tests for the hardening pass. Each one pins a behaviour that
//! was demonstrably wrong before, so the fix cannot quietly rot back out.
use std::net::SocketAddr;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use runa_server::build_router;
use runa_server::sha2::{Digest, Sha256};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn spawn(cfg: runa_server::config::Config) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = runa_server::AppState::new(cfg);
    let app = build_router(state);
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    format!("http://{addr}")
}

fn cfg() -> runa_server::config::Config {
    runa_server::config::Config {
        auth_floor: Duration::from_millis(10),
        dist_dir: "/nonexistent".into(),
        ..Default::default()
    }
}

fn rand32() -> [u8; 32] {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).unwrap();
    b
}
fn rand16() -> [u8; 16] {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).unwrap();
    b
}

struct Keys {
    hex: String,
    auth: [u8; 32],
}

async fn create_with(server: &str, ttl: Value) -> Keys {
    let auth = rand32();
    let h: [u8; 32] = Sha256::digest(auth).into();
    let r = reqwest::Client::new()
        .post(format!("{server}/api/rooms/unlisted"))
        .json(&json!({
            "verifier": B64.encode(h),
            "kdf": {"m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(rand16())},
            "ttl": ttl,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201, "room creation failed");
    let body: Value = r.json().await.unwrap();
    Keys { hex: body["room_id"].as_str().unwrap().to_string(), auth }
}

async fn create(server: &str) -> Keys {
    create_with(server, json!({"kind": "idle-peers", "secs": 3600})).await
}

fn join_frame(room_hex: &str, auth: Option<&[u8; 32]>) -> Message {
    let mut f: Vec<u8> = vec![0x52, 0x55, 0x01, 0x01];
    f.extend_from_slice(&hex::decode(room_hex).unwrap());
    f.extend_from_slice(&[0u8; 4]);
    f.extend_from_slice(&[1, 2, 3, 4]);
    f.extend_from_slice(&[0u8; 4]);
    let body = json!({"auth_key": auth.map(|k| B64.encode(k)), "pubkey": B64.encode([7u8; 32])});
    f.extend_from_slice(body.to_string().as_bytes());
    Message::Binary(f.into())
}

fn json_frame(room_hex: &str, ft: u8, v: Value) -> Message {
    let mut f: Vec<u8> = vec![0x52, 0x55, 0x01, ft];
    f.extend_from_slice(&hex::decode(room_hex).unwrap());
    f.extend_from_slice(&[0u8; 4]);
    f.extend_from_slice(&[1, 2, 3, 4]);
    f.extend_from_slice(&[0u8; 4]);
    f.extend_from_slice(v.to_string().as_bytes());
    Message::Binary(f.into())
}

async fn connect(server: &str, hex: &str) -> Ws {
    let url = format!("{}/socket/{hex}", server.replacen("http://", "ws://", 1));
    tokio_tungstenite::connect_async(url.into_client_request().unwrap())
        .await
        .unwrap()
        .0
}

async fn next_ft(ws: &mut Ws, ft: u8) -> Vec<u8> {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timeout")
            .expect("closed")
            .unwrap();
        if let Message::Binary(b) = m {
            if b.len() >= 4 && b[3] == ft {
                return b.to_vec();
            }
        }
    }
}

async fn join(server: &str, k: &Keys) -> Ws {
    let mut ws = connect(server, &k.hex).await;
    ws.send(join_frame(&k.hex, Some(&k.auth))).await.unwrap();
    let _ = next_ft(&mut ws, 0x02).await;
    ws
}

/// PROTOCOL.md amendment C: server-authored event frames are never enveloped.
/// PEER_LEAVE was, so every client's `JSON.parse` of the body threw — rosters
/// never shed departed peers and shred consensus could never complete.
#[tokio::test]
async fn peer_leave_is_not_enveloped_and_parses_as_json() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;
    let mut a = join(&s, &k).await;
    let b = join(&s, &k).await;
    let _ = next_ft(&mut a, 0x07).await;

    drop(b);
    let leave = next_ft(&mut a, 0x08).await;
    let parsed: Value = serde_json::from_slice(&leave[32..])
        .expect("PEER_LEAVE body must be JSON directly after the 32-byte header");
    assert!(parsed["peer_id"].is_string());
}

/// PEER_JOIN and TTL_EXTEND travel the same path and must stay unenveloped.
#[tokio::test]
async fn peer_join_and_ttl_extend_are_not_enveloped() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;
    let mut a = join(&s, &k).await;
    let mut b = join(&s, &k).await;

    let evt = next_ft(&mut a, 0x07).await;
    serde_json::from_slice::<Value>(&evt[32..]).expect("PEER_JOIN body must be JSON");

    b.send(json_frame(&k.hex, 0x22, json!({"add_secs": 600}))).await.unwrap();
    let ttl = next_ft(&mut a, 0x22).await;
    let v: Value = serde_json::from_slice(&ttl[32..]).expect("TTL_EXTEND body must be JSON");
    assert_eq!(v["add_secs"], 600);
}

/// Throttling must not become an existence oracle: a real room that has run
/// out of auth attempts has to answer exactly like an id that was never used.
#[tokio::test]
async fn auth_throttling_never_reveals_that_a_room_exists() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;
    let wrong = rand32();
    let missing = hex::encode(rand16());

    let probe = |room: String| {
        let s = s.clone();
        async move {
            let mut codes = Vec::new();
            for _ in 0..10 {
                let mut w = connect(&s, &room).await;
                w.send(join_frame(&room, Some(&wrong))).await.unwrap();
                let f = next_ft(&mut w, 0x30).await;
                codes.push(
                    serde_json::from_slice::<Value>(&f[32..]).unwrap()["code"].as_u64().unwrap(),
                );
            }
            codes
        }
    };

    let existing = probe(k.hex.clone()).await;
    let absent = probe(missing).await;
    assert!(existing.iter().all(|c| *c == 4001), "leaked {existing:?}");
    assert!(absent.iter().all(|c| *c == 4001), "leaked {absent:?}");
}

/// Creation used to answer 409 for a live id and 201 for an unused one, which
/// is the same oracle by another route. Ids are assigned by the server now.
#[tokio::test]
async fn creation_does_not_reveal_whether_an_id_is_in_use() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;
    let r = reqwest::Client::new()
        .post(format!("{s}/api/rooms/unlisted"))
        .json(&json!({
            "id": k.hex,
            "verifier": B64.encode(rand32()),
            "kdf": {"m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(rand16())},
            "ttl": {"kind": "idle-peers", "secs": 60},
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201, "a taken id must not be distinguishable");
    let body: Value = r.json().await.unwrap();
    assert_ne!(
        body["room_id"].as_str().unwrap(),
        k.hex,
        "the server must ignore the requested id"
    );
}

/// One peer must not be able to destroy a room the others never voted on.
#[tokio::test]
async fn a_single_peer_cannot_force_a_purge_with_banked_acks() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;
    let mut honest = join(&s, &k).await;

    let mut socks = Vec::new();
    for _ in 0..4 {
        socks.push(join(&s, &k).await);
    }
    for w in socks.iter_mut() {
        w.send(json_frame(&k.hex, 0x14, json!({"request_id": "consensus"}))).await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut last = socks.pop().unwrap();
    drop(socks);
    tokio::time::sleep(Duration::from_millis(200)).await;
    last.send(json_frame(&k.hex, 0x14, json!({"request_id": "consensus"}))).await.unwrap();

    let purged = tokio::time::timeout(Duration::from_secs(2), next_ft(&mut honest, 0x13)).await;
    assert!(purged.is_err(), "the honest peer never approved this shred");
}

/// ...and consensus must still work when everyone genuinely agrees.
#[tokio::test]
async fn unanimous_acks_still_purge_the_room() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;
    let mut a = join(&s, &k).await;
    let mut b = join(&s, &k).await;

    a.send(json_frame(&k.hex, 0x14, json!({"request_id": "r1"}))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    b.send(json_frame(&k.hex, 0x14, json!({"request_id": "r1"}))).await.unwrap();

    let purged = tokio::time::timeout(Duration::from_secs(3), next_ft(&mut a, 0x13)).await;
    assert!(purged.is_ok(), "genuine unanimity must purge");
}

/// TTL extension is capped, so a room cannot be pinned in memory forever.
#[tokio::test]
async fn ttl_extension_saturates_at_the_ceiling() {
    let s = spawn(cfg()).await;
    let k = create_with(&s, json!({"kind": "absolute", "secs": 60})).await;
    let mut a = join(&s, &k).await;
    let mut effective = 0u64;
    for _ in 0..40 {
        a.send(json_frame(&k.hex, 0x22, json!({"add_secs": 720 * 3600}))).await.unwrap();
        let f = next_ft(&mut a, 0x22).await;
        effective =
            serde_json::from_slice::<Value>(&f[32..]).unwrap()["effective_secs"].as_u64().unwrap();
    }
    let ceiling = 60 + runa_server::runar::room::MAX_TTL_EXTENSION_SECS;
    assert_eq!(effective, ceiling, "extension must saturate at the ceiling");
}

/// The room budget is the backstop that keeps a shared host safe.
#[tokio::test]
async fn room_creation_stops_at_the_configured_budget() {
    let s = spawn(runa_server::config::Config { max_rooms: 3, ..cfg() }).await;
    for _ in 0..3 {
        let _ = create(&s).await;
    }
    let r = reqwest::Client::new()
        .post(format!("{s}/api/rooms/unlisted"))
        .json(&json!({
            "verifier": B64.encode(rand32()),
            "kdf": {"m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(rand16())},
            "ttl": {"kind": "idle-peers", "secs": 60},
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 503);
    assert_eq!(r.json::<Value>().await.unwrap()["code"], "AT_CAPACITY");
}

/// An immortal room is a permanent memory reservation; the flag that creates
/// one is an operator decision, not a caller's.
#[tokio::test]
async fn ceiling_optout_is_refused_unless_the_operator_enables_it() {
    let s = spawn(cfg()).await;
    let k = {
        let auth = rand32();
        let h: [u8; 32] = Sha256::digest(auth).into();
        let r = reqwest::Client::new()
            .post(format!("{s}/api/rooms/unlisted"))
            .json(&json!({
                "verifier": B64.encode(h),
                "kdf": {"m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(rand16())},
                "ttl": {"kind": "none", "secs": 0},
                "ceiling_optout": true,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 201);
        let body: Value = r.json().await.unwrap();
        Keys { hex: body["room_id"].as_str().unwrap().to_string(), auth }
    };
    let mut a = connect(&s, &k.hex).await;
    a.send(join_frame(&k.hex, Some(&k.auth))).await.unwrap();
    let ack = next_ft(&mut a, 0x02).await;
    let v: Value = serde_json::from_slice(&ack[32..]).unwrap();
    assert_eq!(v["ceiling_optout"], false, "the flag must not be honoured by default");
}

/// An oversized config blob is retained for the room's whole life, so it needs
/// its own limit rather than riding on the request body cap.
#[tokio::test]
async fn oversized_config_blob_is_refused() {
    let s = spawn(cfg()).await;
    let blob = B64.encode(vec![0u8; 64 * 1024]);
    let r = reqwest::Client::new()
        .post(format!("{s}/api/rooms/unlisted"))
        .json(&json!({
            "verifier": B64.encode(rand32()),
            "kdf": {"m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(rand16())},
            "ttl": {"kind": "idle-peers", "secs": 60},
            "config_blob": blob,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 413);
}

/// Rejoining before the drain window closes must put the room back in service.
#[tokio::test]
async fn rejoining_a_draining_room_makes_it_active_again() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;
    let a = join(&s, &k).await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let mut b = connect(&s, &k.hex).await;
    b.send(join_frame(&k.hex, Some(&k.auth))).await.unwrap();
    let _ = next_ft(&mut b, 0x02).await;
    // A second joiner proves the room is serving normally again.
    let mut c = connect(&s, &k.hex).await;
    c.send(join_frame(&k.hex, Some(&k.auth))).await.unwrap();
    let _ = next_ft(&mut c, 0x02).await;
}

/// The process-wide log budget is what actually bounds RAM. `max_rooms ×
/// max_log_bytes` is not a plan; this is.
#[tokio::test]
async fn the_process_wide_log_budget_is_enforced_across_rooms() {
    let s = spawn(runa_server::config::Config {
        max_total_log_bytes: 96 * 1024,
        ..cfg()
    })
    .await;

    // Fill the budget from one room.
    let a = create(&s).await;
    let mut wa = join(&s, &a).await;
    for _ in 0..16 {
        wa.send(doc_update(&a.hex, &[0xAA; 8 * 1024])).await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A second, otherwise-empty room must now be refused storage as well.
    let b = create(&s).await;
    let mut wb = join(&s, &b).await;
    wb.send(doc_update(&b.hex, &[0xBB; 8 * 1024])).await.unwrap();
    let err = tokio::time::timeout(Duration::from_secs(3), next_ft(&mut wb, 0x30)).await;
    assert!(err.is_ok(), "storage past the process budget must be refused");
    let v: Value = serde_json::from_slice(&err.unwrap()[32..]).unwrap();
    assert_eq!(v["code"], 4004);
}

fn doc_update(room_hex: &str, payload: &[u8]) -> Message {
    let mut f: Vec<u8> = vec![0x52, 0x55, 0x01, 0x03];
    f.extend_from_slice(&hex::decode(room_hex).unwrap());
    f.extend_from_slice(&[0u8; 4]);
    f.extend_from_slice(&[9, 9, 9, 9]);
    f.extend_from_slice(&[0u8; 4]);
    f.extend_from_slice(payload);
    Message::Binary(f.into())
}

/// The per-IP guard bounds one address; this bounds the sum. Each live
/// connection carries an outbound queue, so without a global cap the memory
/// ceiling has no closed form.
#[tokio::test]
async fn connections_stop_at_the_process_ceiling() {
    let s = spawn(runa_server::config::Config { max_connections: 3, ..cfg() }).await;
    let k = create(&s).await;

    let mut held = Vec::new();
    for _ in 0..3 {
        held.push(join(&s, &k).await);
    }
    // The fourth is refused at the door: the upgrade succeeds, then the
    // server drops the socket without ever answering the JOIN. Either a reset
    // or silence counts as refusal; a JOIN_ACK does not.
    let mut extra = connect(&s, &k.hex).await;
    let _ = extra.send(join_frame(&k.hex, Some(&k.auth))).await;
    let served = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(Ok(m)) = extra.next().await {
            if let Message::Binary(b) = m {
                if b.len() >= 4 && b[3] == 0x02 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(!served, "connection past the ceiling must not be served");

    // Freeing a slot lets the next one in.
    held.pop();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut ok = connect(&s, &k.hex).await;
    ok.send(join_frame(&k.hex, Some(&k.auth))).await.unwrap();
    let _ = next_ft(&mut ok, 0x02).await;
}

/// Every peer wipes and disconnects the instant it acks, so by the time the
/// last ack lands the earlier ackers are gone. Measuring quorum against the
/// *live* set at that moment is satisfied by whoever acked last — one peer,
/// not consensus — which in practice shredded one device per round and left
/// everyone else in the room.
#[tokio::test]
async fn acks_still_count_after_the_acking_peer_disconnects() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;

    let mut a = join(&s, &k).await;
    let mut b = join(&s, &k).await;
    let mut c = join(&s, &k).await;

    // A acks, then leaves — exactly what executeWipe does.
    a.send(json_frame(&k.hex, 0x14, json!({"request_id": "consensus"}))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(150)).await;

    // B acks and leaves too.
    b.send(json_frame(&k.hex, 0x14, json!({"request_id": "consensus"}))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(b);
    tokio::time::sleep(Duration::from_millis(150)).await;

    // C is now the only live peer. Under a live-set comparison its single ack
    // would satisfy "everyone connected has acked" and purge. It must not:
    // the cohort was three, and C completing it is real consensus — so the
    // purge SHOULD fire here, and C should be told.
    c.send(json_frame(&k.hex, 0x14, json!({"request_id": "consensus"}))).await.unwrap();
    let purged = tokio::time::timeout(Duration::from_secs(3), next_ft(&mut c, 0x13)).await;
    assert!(purged.is_ok(), "all three cohort members acked; the room must be purged");
}

/// The inverse: a lone peer must not reach quorum just because the others
/// left without ever acking.
#[tokio::test]
async fn a_departed_peer_that_never_acked_still_blocks_the_purge() {
    let s = spawn(cfg()).await;
    let k = create(&s).await;

    let mut attacker = join(&s, &k).await;
    let honest = join(&s, &k).await;

    // Attacker acks first, fixing the cohort at both peers.
    attacker.send(json_frame(&k.hex, 0x14, json!({"request_id": "x"}))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;

    // The honest peer's connection drops without ever approving.
    drop(honest);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Attacker re-acks, now alone. The cohort still contains the honest peer.
    attacker.send(json_frame(&k.hex, 0x14, json!({"request_id": "x"}))).await.unwrap();
    let purged = tokio::time::timeout(Duration::from_secs(2), next_ft(&mut attacker, 0x13)).await;
    assert!(purged.is_err(), "a peer that never acked must keep blocking the purge");
}

/// Named rooms live at the root now. The shell must be served for anything
/// that could be a room name, and must NOT shadow a real asset or an API
/// route — the whole risk of moving into the root namespace.
#[tokio::test]
async fn bare_room_names_resolve_without_shadowing_real_paths() {
    let dist = std::env::temp_dir().join(format!("runa-dist-{}", std::process::id()));
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "<div id=\"root\"></div>").unwrap();
    std::fs::write(dist.join("gone.html"), "TOMBSTONE").unwrap();
    std::fs::write(dist.join("assets/app.js"), "console.log(1)").unwrap();

    let s = spawn(runa_server::config::Config {
        dist_dir: dist.to_string_lossy().into_owned(),
        ..cfg()
    })
    .await;
    let get = |path: &str| {
        let s = s.clone();
        let path = path.to_string();
        async move {
            let r = reqwest::get(format!("{s}{path}")).await.unwrap();
            (r.status().as_u16(), r.text().await.unwrap_or_default())
        }
    };

    // Name-shaped paths get the shell.
    for name in ["/copper-lantern", "/standup-4f2a", "/room7", "/assets-2024"] {
        let (code, body) = get(name).await;
        assert_eq!(code, 200, "{name} should serve the shell");
        assert!(body.contains("id=\"root\""), "{name} served the wrong body");
    }

    // Real files still win — this is the collision the root namespace risks.
    let (code, body) = get("/gone.html").await;
    assert_eq!((code, body.as_str()), (200, "TOMBSTONE"), "a real file must win");
    let (code, body) = get("/assets/app.js").await;
    assert_eq!(code, 200);
    assert!(body.contains("console.log"), "asset must not be shadowed");

    // API routes are untouched.
    let (code, _) = get("/version").await;
    assert_eq!(code, 200, "/version must stay an API route");

    // Reserved and malformed names are not rooms, so they 404 rather than
    // handing out a shell for an address that can never resolve.
    for bad in ["/api", "/socket", "/admin", "/version-", "/ab", "/nope.txt"] {
        let (code, _) = get(bad).await;
        assert_eq!(code, 404, "{bad} must not serve the shell");
    }

    std::fs::remove_dir_all(&dist).ok();
}

/// A SNAPSHOT carries the whole document state, so the frame cap is really a
/// ceiling on how large a document's history can still be compacted. At
/// 256 KiB that sat around 4,000 lines — and past it the elected snapshotter
/// was disconnected for an oversized frame every ten minutes, forever, while
/// the log grew until edits stopped being relayed at all.
#[tokio::test]
async fn the_frame_cap_leaves_room_for_a_real_documents_snapshot() {
    let cfg = runa_server::config::Config::from_env();
    // Measured with yjs: ~58 bytes of encoded state per line of code, and a
    // heavily co-edited document runs about 1.16x that.
    let bytes_per_line = 58.0 * 1.16;
    let lines = (cfg.max_frame_bytes as f64 - 64.0) / bytes_per_line;
    assert!(
        lines > 10_000.0,
        "frame cap {} only allows a ~{:.0}-line document to compact its history",
        cfg.max_frame_bytes,
        lines
    );
}

/// Oversized frames must be refused, not silently truncated — the client is
/// expected to never send one, and this is the backstop.
#[tokio::test]
async fn an_oversized_frame_still_closes_the_connection() {
    let s = spawn(runa_server::config::Config { max_frame_bytes: 4096, ..cfg() }).await;
    let k = create(&s).await;
    let mut a = join(&s, &k).await;

    let mut big: Vec<u8> = vec![0x52, 0x55, 0x01, 0x03];
    big.extend_from_slice(&hex::decode(&k.hex).unwrap());
    big.extend_from_slice(&[0u8; 12]);
    big.extend_from_slice(&vec![0xAB; 8192]);
    let _ = a.send(Message::Binary(big.into())).await;

    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(msg) = a.next().await {
            match msg {
                Ok(Message::Close(_)) | Err(_) => return true,
                _ => continue,
            }
        }
        true
    })
    .await;
    assert!(closed.unwrap_or(false), "an oversized frame must close the socket");
}
