pub mod frame;
pub mod http;
pub mod limits;
pub mod router;

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::bifrost::frame::*;
use crate::runar::room::TtlKind;
use crate::error::WireCode;
use crate::gjallarhorn;
use crate::heimdall::ratelimit::RateLimiter;
use crate::heimdall::verifier;
use crate::runar::log::LogEntry;
use crate::runar::room::{
    JoinError, PurgeAckStatus, Room, RoomState,
};
use crate::surtr;
use crate::AppState;

const JOIN_TIMEOUT: Duration = Duration::from_secs(10);
/// Slot count only. The real bound on a peer's outbound queue is
/// `max_queued_bytes_per_conn`, enforced by `PeerTx` — 512 slots of
/// `max_frame_bytes` each would be 128 MiB that nothing accounts for.
const OUTBOUND_CAPACITY: usize = 512;

fn json_frame(room_id: [u8; 16], frame_type: u8, body: &impl Serialize) -> Bytes {
    let header = Header::new(frame_type, room_id, 0, [0; 4], 0);
    let mut raw = header.encode();
    raw.extend_from_slice(&serde_json::to_vec(body).expect("json serialisation cannot fail"));
    Bytes::from(raw)
}

fn error_frame(room_id: [u8; 16], code: WireCode) -> Bytes {
    json_frame(room_id, FT_ERROR, &serde_json::json!({ "code": u16::from(code) }))
}

async fn floor_delay(floor: Duration) {
    tokio::time::sleep(floor).await;
}

#[derive(Deserialize)]
struct JoinBody {
    #[serde(default)]
    auth_key: Option<String>,
    #[serde(default)]
    pubkey: Option<String>,
}

#[derive(Serialize)]
struct RosterJson {
    peer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pubkey: Option<String>,
    joined_at_seq: u64,
}

#[derive(Serialize)]
struct JoinAck {
    peer_id: String,
    epoch: u32,
    log_len: u64,
    base_index: u64,
    has_snapshot: bool,
    ttl: TtlJson,
    ceiling_optout: bool,
    kdf: KdfJson,
    #[serde(skip_serializing_if = "Option::is_none")]
    config_blob: Option<String>,
    roster: Vec<RosterJson>,
}

#[derive(Serialize)]
struct TtlJson {
    kind: &'static str,
    secs: u64,
}

#[derive(Serialize)]
struct KdfJson {
    alg: &'static str,
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
}

/// Seconds left before the scheduler will sweep this room, from now. For
/// absolute TTLs that is the deadline minus elapsed time; for idle TTLs it is
/// the length of the window the next activity restarts.
fn remaining_secs(room: &Room) -> u64 {
    match room.ttl.kind {
        TtlKind::None => 0,
        TtlKind::Absolute => {
            let elapsed = crate::runar::room::unix_now().saturating_sub(room.created_unix);
            room.effective_ttl_secs().saturating_sub(elapsed)
        }
        _ => room.effective_ttl_secs(),
    }
}

fn ttl_json(room: &Room) -> TtlJson {
    let kind = match room.ttl.kind {
        crate::runar::room::TtlKind::Absolute => "absolute",
        crate::runar::room::TtlKind::IdleEdit => "idle-edit",
        crate::runar::room::TtlKind::IdlePeers => "idle-peers",
        crate::runar::room::TtlKind::None => "none",
    };
    TtlJson { kind, secs: remaining_secs(room) }
}

struct ConnLimits {
    frames: RateLimiter<()>,
    bytes: RateLimiter<()>,
}

impl ConnLimits {
    fn new(cfg: &crate::config::Config) -> Self {
        ConnLimits {
            frames: RateLimiter::new(cfg.frames_per_conn_per_sec * 2, Duration::from_secs(2), 1),
            bytes: RateLimiter::new(
                (cfg.bytes_per_conn_per_sec.saturating_mul(2)).min(u32::MAX as u64) as u32,
                Duration::from_secs(2),
                1,
            ),
        }
    }

    fn allow(&self, len: usize) -> bool {
        self.frames.check(&()) && self.bytes.check_n(&(), len.max(1) as u32)
    }
}

pub async fn handle_socket(socket: WebSocket, state: AppState, room_hex: String, ip: String) {
    // Process-wide first: the per-IP guard bounds one address, not the sum.
    let max = state.cfg.max_connections;
    if state
        .live_conns
        .fetch_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |n| (n < max).then_some(n + 1),
        )
        .is_err()
    {
        tracing::warn!(max, "connection ceiling reached; refusing socket");
        return;
    }
    let _conn_slot = ConnSlot(state.live_conns.clone());

    if !state.conn_guard.acquire(&ip) {
        return;
    }
    let ip_for_release = ip.clone();
    let result =
        run_connection(socket, state.clone(), room_hex, cfg_of(&state), ip).await;
    state.conn_guard.release(&ip_for_release);
    if let Err(code) = result {
        tracing::debug!(closed_by = u16::from(code), "socket closed");
    }
}

/// Returns the process-wide connection slot on every exit path, including
/// the early returns above.
struct ConnSlot(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for ConnSlot {
    fn drop(&mut self) {
        self.0
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |n| Some(n.saturating_sub(1)),
            )
            .ok();
    }
}

fn cfg_of(state: &AppState) -> std::sync::Arc<crate::config::Config> {
    state.cfg.clone()
}

type ConnResult = Result<(), WireCode>;

async fn run_connection(
    socket: WebSocket,
    state: AppState,
    room_hex: String,
    cfg: std::sync::Arc<crate::config::Config>,
    ip: String,
) -> ConnResult {
    let _ = &ip;
    let (mut sink, mut stream) = socket.split();
    let Some(room_id) = http::parse_room_hex(&room_hex) else {
        return Err(WireCode::ProtocolError);
    };

    // Read the first frame BEFORE revealing whether the room exists: a
    // probe that connects and sends nothing must be indistinguishable from
    // one aimed at a live room (both wait up to JOIN_TIMEOUT in silence).
    let first = match timeout(JOIN_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Binary(b)))) => b,
        _ => {
            // Identical silence-then-close for existing and missing rooms.
            if state.rooms.get(&room_id).is_none() {
                floor_delay(cfg.auth_floor).await;
                let _ = sink
                    .send(Message::Binary(error_frame(room_id, WireCode::AuthFailed)))
                    .await;
                return Err(WireCode::AuthFailed);
            }
            return Err(WireCode::ProtocolError);
        }
    };
    let header = Header::decode(&first);
    let valid_join_header = matches!(
        header,
        Some(ref h) if h.version == VERSION && h.frame_type == FT_JOIN && h.room_id == room_id
    );

    let Some(room) = state.rooms.get(&room_id) else {
        floor_delay(cfg.auth_floor).await;
        let _ = sink
            .send(Message::Binary(error_frame(room_id, WireCode::AuthFailed)))
            .await;
        return Err(WireCode::AuthFailed);
    };

    if !valid_join_header {
        floor_delay(cfg.auth_floor).await;
        let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::AuthFailed))).await;
        return Err(WireCode::AuthFailed);
    }
    let header = header.expect("validated above");
        #[allow(unused_variables)]
        let header_ref = &header;

    // A room mid-purge is, from outside, indistinguishable from one that was
    // never here. Peers already inside learn about the purge over their live
    // socket; a new connection gets the same answer as any bad id.
    match room.current_state() {
        RoomState::Active | RoomState::Draining => {}
        _ => {
            floor_delay(cfg.auth_floor).await;
            let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::AuthFailed))).await;
            return Err(WireCode::AuthFailed);
        }
    }
    if first.len() > cfg.max_frame_bytes {
        let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::FrameTooLarge))).await;
        return Err(WireCode::FrameTooLarge);
    }
    let header = Header::decode(&first).ok_or(WireCode::ProtocolError)?;
    if header.version != VERSION || header.frame_type != FT_JOIN || header.room_id != room_id {
        let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::ProtocolError))).await;
        return Err(WireCode::ProtocolError);
    }

    let join: JoinBody = serde_json::from_slice(&first[HEADER_LEN..])
        .unwrap_or(JoinBody { auth_key: None, pubkey: None });

    // A throttled room must not answer differently from a room that does not
    // exist. Returning 4002 here was a clean existence oracle: five bad
    // guesses at a real room id flipped the code to RateLimited, while a
    // missing id answered 4001 forever. Same code, same delay, either way.
    if !room.auth_allowed() {
        floor_delay(cfg.auth_floor).await;
        let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::AuthFailed))).await;
        return Err(WireCode::AuthFailed);
    }

    let presented = join.auth_key.as_deref().unwrap_or("");
    let presented_bytes = B64.decode(presented).unwrap_or_default();
    let auth_ok = verifier::verify(room.verifier_ref(), &presented_bytes);
    drop(presented_bytes);

    if !state.auth_per_ip.check(&ip) {
        floor_delay(cfg.auth_floor).await;
        let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::AuthFailed))).await;
        return Err(WireCode::AuthFailed);
    }

    if !auth_ok {
        let backoff = room.record_auth_failure();
        tracing::info!(backoff_secs = backoff.as_secs(), "auth failed");
        floor_delay(cfg.auth_floor).await;
        let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::AuthFailed))).await;
        return Err(WireCode::AuthFailed);
    }
    room.auth_success();

    let session_pubkey: Option<Vec<u8>> = join
        .pubkey
        .as_deref()
        .and_then(|k| B64.decode(k).ok())
        .filter(|v| v.len() == 32 || v.len() == 65);

    let (tx, mut rx) = mpsc::channel::<Bytes>(OUTBOUND_CAPACITY);
    let peer_tx = crate::runar::room::PeerTx::new(tx, cfg.max_queued_bytes_per_conn);
    let queue_meter = peer_tx.meter();
    let entry = match room.add_peer(session_pubkey.clone(), peer_tx) {
        Ok(e) => e,
        Err(JoinError::Full) => {
            let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::RoomFull))).await;
            return Err(WireCode::RoomFull);
        }
        Err(JoinError::AuthLockedOut(_)) => {
            floor_delay(cfg.auth_floor).await;
            let _ = sink.send(Message::Binary(error_frame(room_id, WireCode::AuthFailed))).await;
            return Err(WireCode::AuthFailed);
        }
    };
    let peer_id = entry.peer_id;

    {
        let ack = JoinAck {
            peer_id: B64.encode(peer_id),
            epoch: room.epoch.load(std::sync::atomic::Ordering::SeqCst),
            log_len: room.log.read().unwrap().log_len(),
            base_index: room.log.read().unwrap().base_index(),
            has_snapshot: room.log.read().unwrap().has_snapshot(),
            ttl: ttl_json(&room),
            ceiling_optout: room.ceiling_optout,
            kdf: KdfJson {
                alg: "argon2id",
                m_kib: room.kdf_m_kib,
                t: room.kdf_t,
                p: room.kdf_p,
                salt: B64.encode(room.salt),
            },
            config_blob: room.config_blob.as_ref().map(|b| B64.encode(b)),
            roster: room
                .roster()
                .into_iter()
                .map(|p| RosterJson {
                    peer_id: B64.encode(p.peer_id),
                    pubkey: p.pubkey.map(|k| B64.encode(k)),
                    joined_at_seq: p.joined_at_seq,
                })
                .collect(),
        };
        let frame = json_frame(room_id, FT_JOIN_ACK, &ack);
        if sink.send(Message::Binary(frame)).await.is_err() {
            room.remove_peer(&peer_id);
            return Err(WireCode::ProtocolError);
        }
    }

    let join_evt = json_frame(
        room_id,
        FT_PEER_JOIN,
        &serde_json::json!({
            "peer_id": B64.encode(peer_id),
            "pubkey": session_pubkey.map(|k| B64.encode(k)),
            "joined_at_seq": entry.joined_at_seq,
        }),
    );
    room.broadcast_event(&join_evt, None).await;

    if room.current_state() == RoomState::Draining {
        // Somebody came back before the grace window closed.
        room.mark_state(RoomState::Active);
    }

    let limits = ConnLimits::new(&cfg);
    let mut conn_ok: ConnResult = Ok(());
    // One sync replay in flight per connection. Each DOC_SYNC_REQ can pull the
    // whole room log, so letting them queue turns one small frame into an
    // unbounded fan-out of spawned tasks and egress.
    let sync_slot = std::sync::Arc::new(tokio::sync::Semaphore::new(1));

    loop {
        tokio::select! {
            inbound = stream.next() => {
                match inbound {
                    Some(Ok(Message::Binary(data))) => {
                        if data.len() > cfg.max_frame_bytes {
                            conn_ok = Err(WireCode::FrameTooLarge);
                            break;
                        }
                        if !limits.allow(data.len()) {
                            conn_ok = Err(WireCode::RateLimited);
                            break;
                        }
                        match process_frame(&state, &room, peer_id, &data, &sync_slot).await {
                            Ok(()) => {}
                            Err(Some(code)) => { conn_ok = Err(code); break; }
                            Err(None) => {}
                        }
                    }
                    Some(Ok(Message::Text(_))) => {
                        conn_ok = Err(WireCode::ProtocolError);
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(bytes) => {
                        let is_purge = bytes.len() >= HEADER_LEN && bytes[3] == FT_PURGE;
                        let n = bytes.len();
                        let sent = sink.send(Message::Binary(bytes)).await;
                        // Quota returns once the frame is off our hands.
                        queue_meter.release(n);
                        if sent.is_err() {
                            break;
                        }
                        if is_purge {
                            conn_ok = Err(WireCode::Purged);
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    if let Err(code) = conn_ok {
        let _ = sink
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: u16::from(code),
                reason: "".into(),
            })))
            .await;
    }

    room.remove_peer(&peer_id);
    let leave = json_frame(
        room_id,
        FT_PEER_LEAVE,
        &serde_json::json!({
            "peer_id": B64.encode(peer_id),
            "reason": conn_ok.err().map(u16::from),
        }),
    );
    room.broadcast_event(&leave, Some(peer_id)).await;
    if room.peer_count() == 0 && room.current_state() == RoomState::Active {
        room.mark_state(RoomState::Draining);
    }
    conn_ok
}

/// Returns Ok on handled, Err(Some(code)) to close, Err(None) silently ignored.
async fn process_frame(
    state: &AppState,
    room: &std::sync::Arc<Room>,
    sender: [u8; 16],
    data: &[u8],
    sync_slot: &std::sync::Arc<tokio::sync::Semaphore>,
) -> Result<(), Option<WireCode>> {
    let Some(header) = Header::decode(data) else {
        return Err(Some(WireCode::ProtocolError));
    };
    if header.version != VERSION || header.room_id != room.id {
        return Err(Some(WireCode::ProtocolError));
    }
    if data.len() < HEADER_LEN {
        return Err(Some(WireCode::ProtocolError));
    }
    let frame_bytes = Bytes::copy_from_slice(data);

    match header.frame_type {
        FT_DOC_UPDATE => {
            room.touch();
            let append_result = {
                let mut log = room.log.write().unwrap();
                log.append(sender, FT_DOC_UPDATE, header.epoch, frame_bytes.clone())
            };
            match append_result {
                Ok(_) => room.broadcast(&frame_bytes, Some(sender)).await,
                Err(_) => send_direct(room, sender, error_frame(room.id, WireCode::FrameTooLarge)),
            }
            Ok(())
        }

        FT_AWARENESS => {
            room.broadcast(&frame_bytes, Some(sender)).await;
            Ok(())
        }

        FT_SNAPSHOT => {
            if frame_bytes.len() < HEADER_LEN + 8 {
                return Err(None);
            }
            // Deterministic election (spec §5.8): only the lowest
            // joined_at_seq peer currently in the room may compact the log.
            // Anything else is refused before it can truncate history.
            let min_seq = room
                .peers
                .lock()
                .unwrap()
                .iter()
                .map(|p| p.joined_at_seq)
                .min();
            let sender_seq = room
                .peers
                .lock()
                .unwrap()
                .iter()
                .find(|p| p.peer_id == sender)
                .map(|p| p.joined_at_seq);
            if sender_seq != min_seq || sender_seq.is_none() {
                send_direct(
                    room,
                    sender,
                    error_frame(room.id, WireCode::ProtocolError),
                );
                return Ok(());
            }
            let covers = u64::from_be_bytes([
                data[32], data[33], data[34], data[35], data[36], data[37], data[38], data[39],
            ]);
            let entry = LogEntry {
                sender,
                frame_type: FT_SNAPSHOT,
                epoch: header.epoch,
                frame: frame_bytes.clone(),
            };
            let applied = {
                let mut log = room.log.write().unwrap();
                log.apply_snapshot(covers, entry)
            };
            if applied {
                room.touch();
                room.broadcast(&frame_bytes, Some(sender)).await;
            } else {
                send_direct(room, sender, error_frame(room.id, WireCode::ProtocolError));
            }
            Ok(())
        }

        FT_DOC_SYNC_REQ => {
            let from_index: u64 = serde_json::from_slice::<serde_json::Value>(&data[HEADER_LEN..])
                .ok()
                .and_then(|v| v.get("from_index").and_then(|x| x.as_u64()))
                .unwrap_or(0);
            let chunk = {
                let log = room.log.read().unwrap();
                log.tail_from(from_index)
            };
            if let Some(tx) = room.sender_for(&sender) {
                // Spawn off the connection's critical path so `send().await`
                // exerts real backpressure; the select loop is free to drain
                // rx concurrently because process_frame has already returned.
                // The permit caps this at one replay per connection: without
                // it, a peer could fire sync requests at the frame limit and
                // have the server clone and push the whole log for each one.
                let Ok(permit) = sync_slot.clone().try_acquire_owned() else {
                    return Ok(());
                };
                tokio::spawn(async move {
                    let _permit = permit;
                    for entry in chunk.snapshot.into_iter().chain(chunk.entries) {
                        if tx.send_backpressured(envelop_entry(&entry)).await.is_err() {
                            break;
                        }
                    }
                });
            }
            Ok(())
        }

        FT_SHRED_REQUEST | FT_SHRED_VOTE | FT_SHRED_CANCEL | FT_EPOCH_KEY => {
            gjallarhorn::relay(room, &frame_bytes, sender).await;
            Ok(())
        }

        FT_TTL_EXTEND => {
            let add_secs = serde_json::from_slice::<serde_json::Value>(&data[HEADER_LEN..])
                .ok()
                .and_then(|v| v.get("add_secs").and_then(|x| x.as_u64()));
            if let Some(add) = add_secs {
                if !(1..=720 * 3600).contains(&add) {
                    return Err(None);
                }
                let _total_ext = room.extend_ttl(add);
                room.touch();
                let effective = match room.ttl.kind {
                    TtlKind::None => 0,
                    _ => room.effective_ttl_secs(),
                };
                // The server clamps extensions at a ceiling, so `add_secs` is
                // a request, not a result. Clients must re-anchor on a value
                // the server computed — otherwise the extender's local clock
                // drifts past the real deadline (and double-counts its own
                // request on top of the broadcast).
                let remaining = remaining_secs(room);
                let evt = json_frame(
                    room.id,
                    FT_TTL_EXTEND,
                    &serde_json::json!({
                        "added_by": B64.encode(sender),
                        "add_secs": add,
                        "effective_secs": effective,
                        "remaining_secs": remaining,
                        "kind": match room.ttl.kind {
                            TtlKind::Absolute => "absolute",
                            TtlKind::IdleEdit => "idle-edit",
                            TtlKind::IdlePeers => "idle-peers",
                            TtlKind::None => "none",
                        },
                    }),
                );
                room.broadcast_event(&evt, None).await;
            }
            Ok(())
        }

        FT_PURGE_ACK => {
            let request_id = serde_json::from_slice::<serde_json::Value>(&data[HEADER_LEN..])
                .ok()
                .and_then(|v| v.get("request_id").and_then(|x| x.as_str()).map(str::to_string));
            if let Some(request_id) = request_id {
                if request_id.len() > crate::runar::room::MAX_PURGE_REQUEST_ID_LEN {
                    return Err(None);
                }
                match room.note_purge_ack(&request_id, sender) {
                    PurgeAckStatus::Pending => {}
                    PurgeAckStatus::AllAcked(id) => {
                        tracing::info!(request = %id, "all connected peers acked; purging");
                        surtr::purge(&state.rooms, &room.id, "shred-consensus").await;
                    }
                }
            }
            Ok(())
        }

        _ => Err(Some(WireCode::ProtocolError)),
    }
}

fn send_direct(room: &Room, target: [u8; 16], payload: Bytes) {
    let peers = room.peers.lock().unwrap();
    if let Some(p) = peers.iter().find(|p| p.peer_id == target) {
        let _ = p.tx.try_send(payload);
    }
}

fn envelop_entry(entry: &LogEntry) -> Bytes {
    let frame = &entry.frame;
    if frame.len() < HEADER_LEN {
        return frame.clone();
    }
    let mut out = Vec::with_capacity(frame.len() + 16);
    out.extend_from_slice(&frame[..HEADER_LEN]);
    out.extend_from_slice(&entry.sender);
    out.extend_from_slice(&frame[HEADER_LEN..]);
    Bytes::from(out)
}
