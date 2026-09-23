//! Amendments G, H and I: the heartbeat, relayed log indexes, and rooms that
//! outlive a restart.

use std::net::SocketAddr;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use runa_server::build_router;
use runa_server::runar::ticket::RestartKey;
use runa_server::sha2::{Digest, Sha256};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const KEY: [u8; 32] = [0x42; 32];

fn config(key: Option<[u8; 32]>) -> runa_server::config::Config {
    runa_server::config::Config {
        auth_floor: Duration::from_millis(50),
        dist_dir: "/nonexistent".into(),
        restart_key: key.map(RestartKey),
        ..runa_server::config::Config::default()
    }
}

async fn spawn(cfg: runa_server::config::Config) -> (String, runa_server::AppState) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = runa_server::AppState::new(cfg);
    let app = build_router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    (format!("http://{addr}"), state)
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).unwrap();
    b
}

struct Keys {
    room: String,
    auth: [u8; 32],
}

fn verifier_for(key: &[u8; 32]) -> String {
    let h: [u8; 32] = Sha256::digest(key).into();
    B64.encode(h)
}

async fn create_room(server: &str, ttl: Value) -> Keys {
    let auth: [u8; 32] = random();
    let resp = reqwest::Client::new()
        .post(format!("{server}/api/rooms/unlisted"))
        .json(&json!({
            "verifier": verifier_for(&auth),
            "kdf": { "m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(random::<16>()) },
            "ttl": ttl,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    Keys { room: body["room_id"].as_str().unwrap().to_string(), auth }
}

async fn create_named(server: &str, name: &str) -> Keys {
    let auth: [u8; 32] = random();
    let resp = reqwest::Client::new()
        .post(format!("{server}/api/rooms/named"))
        .json(&json!({
            "name": name,
            "suffix": false,
            "verifier": verifier_for(&auth),
            "kdf": { "m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(random::<16>()) },
            "ttl": { "kind": "idle-peers", "secs": 3600 },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201, "named create");
    let body: Value = resp.json().await.unwrap();
    Keys { room: body["room_id"].as_str().unwrap().to_string(), auth }
}

fn header(room: &str, ft: u8) -> Vec<u8> {
    [0x52u8, 0x55, 0x01, ft]
        .iter()
        .copied()
        .chain(hex::decode(room).unwrap())
        .chain([0u8; 4])
        .chain([1u8, 2, 3, 4])
        .chain([0u8; 4])
        .collect()
}

fn json_frame(room: &str, ft: u8, body: Value) -> Message {
    let mut f = header(room, ft);
    f.extend_from_slice(&serde_json::to_vec(&body).unwrap());
    Message::Binary(f.into())
}

fn join(k: &Keys, pk: u8, caps: Value) -> Message {
    let mut body = json!({ "auth_key": B64.encode(k.auth), "pubkey": B64.encode([pk; 32]) });
    for (name, v) in caps.as_object().unwrap() {
        body[name] = v.clone();
    }
    json_frame(&k.room, 0x01, body)
}

fn update(room: &str, payload: &[u8]) -> Message {
    let mut f = header(room, 0x03);
    f.extend_from_slice(&7u64.to_be_bytes());
    f.extend_from_slice(payload);
    f.extend_from_slice(&[0xAB; 16]);
    Message::Binary(f.into())
}

async fn connect(server: &str, room: &str) -> Ws {
    let url = format!("{}/socket/{room}", server.replacen("http://", "ws://", 1));
    tokio_tungstenite::connect_async(url.into_client_request().unwrap()).await.unwrap().0
}

/// The next binary frame of type `ft`, skipping others.
async fn next_of(ws: &mut Ws, ft: u8) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await.expect("stream ended").unwrap() {
                Message::Binary(b) if b.len() >= 4 && b[3] == ft => return b.to_vec(),
                Message::Close(c) => panic!("closed ({c:?}) waiting for {ft:#x}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for frame {ft:#x}"))
}

fn body_json(frame: &[u8]) -> Value {
    serde_json::from_slice(&frame[32..]).unwrap()
}

async fn joined(server: &str, k: &Keys, pk: u8, caps: Value) -> (Ws, Value) {
    let mut ws = connect(server, &k.room).await;
    ws.send(join(k, pk, caps)).await.unwrap();
    let ack = body_json(&next_of(&mut ws, 0x02).await);
    (ws, ack)
}

async fn close_code(ws: &mut Ws) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(m) = ws.next().await {
            match m {
                Ok(Message::Close(f)) => return f.map(|f| u16::from(f.code)),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
        None
    })
    .await
    .unwrap_or(None)
}

async fn restore(server: &str, ticket: &str) -> (u16, Value) {
    let r = reqwest::Client::new()
        .post(format!("{server}/api/rooms/restore"))
        .json(&json!({ "ticket": ticket }))
        .send()
        .await
        .unwrap();
    let status = r.status().as_u16();
    (status, r.json().await.unwrap_or(Value::Null))
}

// ── H · relayed log indexes ─────────────────────────────────────────────────

/// A snapshot has to say which log index it covers. A client could only
/// count its own stored updates toward that, so the claim fell further behind
/// the more other people typed, and the server refused it outright once a
/// different member became the snapshotter. With the index on every relayed
/// update the client knows exactly what it has.
#[tokio::test]
async fn an_indexed_connection_is_told_each_updates_log_index_live_and_on_replay() {
    let (server, _) = spawn(config(None)).await;
    let k = create_room(&server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let (mut writer, _) = joined(&server, &k, 1, json!({ "acks": true })).await;
    let (mut indexed, ack) = joined(&server, &k, 2, json!({ "indexed": true })).await;
    assert_eq!(ack["indexed"], true, "the JOIN_ACK says it will send indexes");
    let (mut plain, ack) = joined(&server, &k, 3, json!({})).await;
    assert!(ack.get("indexed").is_none(), "a client that did not ask never sees the field");

    for i in 0..3u8 {
        writer.send(update(&k.room, &[i; 40])).await.unwrap();
        assert_eq!(body_json(&next_of(&mut writer, 0x09).await)["index"], i as u64);
    }
    for i in 0..3u8 {
        let f = next_of(&mut indexed, 0x03).await;
        assert_eq!(u64::from_be_bytes(f[48..56].try_into().unwrap()), i as u64);
        assert_eq!(&f[56 + 8..56 + 8 + 40], &[i; 40], "the body follows the index untouched");
        let g = next_of(&mut plain, 0x03).await;
        assert_eq!(g.len(), f.len() - 8, "the ordinary envelope is unchanged");
        assert_eq!(&g[48 + 8..48 + 8 + 40], &[i; 40]);
    }

    indexed
        .send(json_frame(&k.room, 0x04, json!({ "from_index": 1 })))
        .await
        .unwrap();
    for i in 1..3u8 {
        let f = next_of(&mut indexed, 0x03).await;
        assert_eq!(u64::from_be_bytes(f[48..56].try_into().unwrap()), i as u64, "replay is indexed too");
    }
}

// ── G · heartbeat ───────────────────────────────────────────────────────────

/// A connection that dies while nobody types sent nothing that could go
/// unacknowledged, so it was noticed only at the next keystroke. PONG is
/// what a quiet connection can wait for, and it carries the roster so a view
/// that has drifted is put right on the next beat.
#[tokio::test]
async fn a_ping_is_answered_with_the_current_roster_when_the_join_asked_for_it() {
    let (server, _) = spawn(config(None)).await;
    let k = create_room(&server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let (mut a, ack) = joined(&server, &k, 1, json!({ "heartbeat": true })).await;
    assert_eq!(ack["heartbeat"], true);
    let (_b, _) = joined(&server, &k, 2, json!({})).await;

    a.send(json_frame(&k.room, 0x17, json!({}))).await.unwrap();
    let pong = next_of(&mut a, 0x18).await;
    assert_eq!(&pong[20..24], &[0u8; 4], "server-authored, epoch 0");
    assert_eq!(body_json(&pong)["roster"].as_array().unwrap().len(), 2);

    let (mut old, _) = joined(&server, &k, 3, json!({})).await;
    old.send(json_frame(&k.room, 0x17, json!({}))).await.unwrap();
    assert_eq!(close_code(&mut old).await, Some(4005), "PING stays unknown to a client that did not ask");
}

// ── I · restart tickets ─────────────────────────────────────────────────────

/// The whole handover: a room open when the process stops comes back on the
/// next one, under its old id and key, with a new and empty log.
#[tokio::test]
async fn a_room_open_at_a_restart_comes_back_on_the_next_process_from_its_ticket() {
    let (old_server, old) = spawn(config(Some(KEY))).await;
    let k = create_room(&old_server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let (mut a, first_ack) = joined(&old_server, &k, 1, json!({})).await;
    let (mut b, _) = joined(&old_server, &k, 2, json!({})).await;

    old.begin_restart(Duration::from_secs(30)).await;
    assert_eq!(body_json(&next_of(&mut a, 0x15).await)["handover"], true, "the warning says the room will carry over");
    assert_eq!(old.hand_over().await, 1);
    let ticket = body_json(&next_of(&mut a, 0x16).await)["ticket"].as_str().unwrap().to_string();
    assert_eq!(close_code(&mut a).await, Some(1012), "closed as a restart, after the ticket");
    let _ = next_of(&mut b, 0x16).await;

    let (new_server, _) = spawn(config(Some(KEY))).await;
    let mut probe = connect(&new_server, &k.room).await;
    probe.send(join(&k, 9, json!({}))).await.unwrap();
    assert_eq!(body_json(&next_of(&mut probe, 0x30).await)["code"], 4001, "unknown until restored");

    assert_eq!(restore(&new_server, &ticket).await.0, 201);
    assert_eq!(restore(&new_server, &ticket).await.0, 200, "a second member's ticket finds it back already");

    let (_a2, ack) = joined(&new_server, &k, 1, json!({})).await;
    assert_ne!(ack["log_id"], first_ack["log_id"], "the log is new, and says so");
    assert_eq!(ack["log_len"], 0);
    assert_eq!(ack["ttl"]["kind"], "idle-peers");
    let (_bad, _) = {
        let mut ws = connect(&new_server, &k.room).await;
        let wrong = Keys { room: k.room.clone(), auth: random() };
        ws.send(join(&wrong, 5, json!({}))).await.unwrap();
        assert_eq!(body_json(&next_of(&mut ws, 0x30).await)["code"], 4001, "and only its own key opens it");
        (ws, ())
    };
}

#[tokio::test]
async fn a_named_room_comes_back_under_its_name_unless_someone_took_it_first() {
    let (old_server, old) = spawn(config(Some(KEY))).await;
    let k = create_named(&old_server, "meow-restart-1").await;
    let (mut a, _) = joined(&old_server, &k, 1, json!({})).await;
    old.hand_over().await;
    let ticket = body_json(&next_of(&mut a, 0x16).await)["ticket"].as_str().unwrap().to_string();

    let (new_server, _) = spawn(config(Some(KEY))).await;
    assert_eq!(restore(&new_server, &ticket).await.0, 201);
    let resolved: Value = reqwest::Client::new()
        .post(format!("{new_server}/api/names/resolve"))
        .json(&json!({ "name": "meow-restart-1" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resolved["room_id"], k.room, "the name leads to the same room");

    let (squatted, _) = spawn(config(Some(KEY))).await;
    create_named(&squatted, "meow-restart-1").await;
    let (status, body) = restore(&squatted, &ticket).await;
    assert_eq!((status, body["code"].as_u64()), (409, Some(4012)));
}

#[tokio::test]
async fn a_ticket_is_worthless_without_the_same_key() {
    let (old_server, old) = spawn(config(Some(KEY))).await;
    let k = create_room(&old_server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let (mut a, _) = joined(&old_server, &k, 1, json!({})).await;
    old.hand_over().await;
    let ticket = body_json(&next_of(&mut a, 0x16).await)["ticket"].as_str().unwrap().to_string();

    let (keyless, _) = spawn(config(None)).await;
    assert_eq!(restore(&keyless, &ticket).await, (410, json!({ "code": "NO_HANDOVER" })));
    let (other_key, _) = spawn(config(Some([7u8; 32]))).await;
    assert_eq!(restore(&other_key, &ticket).await, (400, json!({ "code": "TICKET_INVALID" })));
    let (same_key, _) = spawn(config(Some(KEY))).await;
    let mut forged = ticket.clone();
    forged.insert(3, if forged.as_bytes()[3] == b'A' { 'B' } else { 'A' });
    assert_eq!(restore(&same_key, &forged).await.0, 400);
}

/// A shred must stay a shred. Tickets are issued only at the moment the old
/// process stops, so a room shredded before then has none; one shredded after
/// being brought back is a tombstone in the new process.
#[tokio::test]
async fn a_ticket_cannot_bring_back_a_room_this_process_has_ended() {
    let (old_server, old) = spawn(config(Some(KEY))).await;
    let k = create_room(&old_server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let (mut a, _) = joined(&old_server, &k, 1, json!({})).await;
    old.hand_over().await;
    let ticket = body_json(&next_of(&mut a, 0x16).await)["ticket"].as_str().unwrap().to_string();

    let (new_server, new) = spawn(config(Some(KEY))).await;
    assert_eq!(restore(&new_server, &ticket).await.0, 201);
    let id: [u8; 16] = hex::decode(&k.room).unwrap().try_into().unwrap();
    runa_server::surtr::purge(&new.rooms, &id, "shred-consensus").await;
    assert_eq!(restore(&new_server, &ticket).await, (410, json!({ "code": "GONE" })));
}

#[tokio::test]
async fn a_room_whose_time_ran_out_during_the_restart_stays_ended() {
    let room = runa_server::runar::room::Room::new(
        random(),
        runa_server::runar::room::RoomClass::Unlisted,
        runa_server::runar::room::unix_now() - 7200,
        runa_server::runar::room::Ttl { kind: runa_server::runar::room::TtlKind::Absolute, secs: 3600 },
        false,
        Some(random()),
        65536,
        3,
        1,
        random(),
        None,
        1 << 20,
        5,
        8,
    );
    let ticket = runa_server::runar::ticket::issue(&RestartKey(KEY), &room, runa_server::runar::room::unix_now())
        .unwrap();
    let (server, _) = spawn(config(Some(KEY))).await;
    assert_eq!(restore(&server, &ticket).await, (410, json!({ "code": "EXPIRED" })));
}

#[tokio::test]
async fn without_a_restart_key_no_tickets_are_issued_and_the_warning_says_so() {
    let (server, state) = spawn(config(None)).await;
    let k = create_room(&server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let (mut a, _) = joined(&server, &k, 1, json!({})).await;
    state.begin_restart(Duration::from_secs(30)).await;
    assert_eq!(body_json(&next_of(&mut a, 0x15).await)["handover"], false);
    assert_eq!(state.hand_over().await, 0);
    a.send(json_frame(&k.room, 0x04, json!({ "from_index": 0 }))).await.unwrap();
    let got = tokio::time::timeout(Duration::from_millis(400), a.next()).await;
    assert!(
        !matches!(got, Ok(Some(Ok(Message::Close(_))))),
        "no ticket, so the connection is left for the process exit to end"
    );
}

// ── Purge cohort ────────────────────────────────────────────────────────────

/// Relayed through the real socket path: the server has to notice the
/// SHRED_REQUEST go by, or someone joining mid-vote still blocks the purge.
#[tokio::test]
async fn a_shred_request_passing_through_decides_who_the_purge_waits_for() {
    let (server, _) = spawn(config(None)).await;
    let k = create_room(&server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let (mut a, _) = joined(&server, &k, 1, json!({})).await;
    let (mut b, _) = joined(&server, &k, 2, json!({})).await;

    let mut request = header(&k.room, 0x10);
    request.extend_from_slice(&[0x5A; 64]);
    a.send(Message::Binary(request.into())).await.unwrap();
    let _ = next_of(&mut b, 0x10).await;

    let (mut late, _) = joined(&server, &k, 3, json!({})).await;
    for ws in [&mut a, &mut b] {
        ws.send(json_frame(&k.room, 0x14, json!({ "request_id": "consensus" }))).await.unwrap();
    }
    assert_eq!(
        body_json(&next_of(&mut late, 0x13).await)["reason"],
        "shred-consensus",
        "the voters agreed; the newcomer, who never saw the request, does not hold the room open"
    );
}

// ── Cross-site requests ─────────────────────────────────────────────────────

async fn ws_with_origin(server: &str, room: &str, origin: &str) -> Result<Ws, String> {
    let url = format!("{}/socket/{room}", server.replacen("http://", "ws://", 1));
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert("origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

/// Another site could have its visitors' browsers send bad joins to RÚNA,
/// spending those visitors' own guess budget until their real rooms answered
/// "no such room". A page on another site must not reach the socket or the API.
#[tokio::test]
async fn a_page_on_another_site_cannot_reach_the_socket_or_the_api() {
    let (server, _) = spawn(config(None)).await;
    let k = create_room(&server, json!({ "kind": "idle-peers", "secs": 3600 })).await;
    let own = server.clone();

    let refused = ws_with_origin(&server, &k.room, "https://evil.example").await;
    assert!(refused.is_err_and(|e| e.contains("403")), "a cross-site handshake must be refused");
    assert!(ws_with_origin(&server, &k.room, "null").await.is_err(), "an opaque origin is refused too");

    let mut ws = ws_with_origin(&server, &k.room, &own).await.expect("the page's own origin connects");
    ws.send(join(&k, 1, json!({}))).await.unwrap();
    let _ = next_of(&mut ws, 0x02).await;

    let create = |headers: Vec<(&'static str, &'static str)>| {
        let server = server.clone();
        async move {
            let mut req = reqwest::Client::new().post(format!("{server}/api/rooms/unlisted")).json(&json!({
                "verifier": verifier_for(&random::<32>()),
                "kdf": { "m_kib": 65536, "t": 3, "p": 1, "salt": B64.encode(random::<16>()) },
                "ttl": { "kind": "idle-peers", "secs": 60 },
            }));
            for (k, v) in headers {
                req = req.header(k, v);
            }
            req.send().await.unwrap().status().as_u16()
        }
    };
    assert_eq!(create(vec![("origin", "https://evil.example")]).await, 403);
    assert_eq!(create(vec![("sec-fetch-site", "cross-site")]).await, 403);
    assert_eq!(create(vec![("sec-fetch-site", "same-site")]).await, 403);
    assert_eq!(create(vec![("sec-fetch-site", "same-origin")]).await, 201);
    assert_eq!(create(vec![]).await, 201, "a client that is not a browser sends neither header");
}
