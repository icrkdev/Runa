use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;
use dashmap::DashMap;
use secrecy::{ExposeSecret, SecretBox as Secret};
use tokio::sync::mpsc;

use crate::bifrost::frame::Header;
use crate::runar::log::{LogBudget, RoomLog};
use crate::runar::names;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtlKind {
    Absolute,
    IdleEdit,
    IdlePeers,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ttl {
    pub kind: TtlKind,
    pub secs: u64,
}

impl Default for Ttl {
    fn default() -> Self {
        Ttl { kind: TtlKind::IdlePeers, secs: 3600 }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomClass {
    Unlisted,
    Named(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomState {
    Active,
    Draining,
    Purging,
    Dead,
}

#[derive(Debug, Clone)]
pub struct RosterEntry {
    pub peer_id: [u8; 16],
    /// Raw public key bytes: 32 B Ed25519 or 65 B uncompressed ECDSA P-256.
    pub pubkey: Option<Vec<u8>>,
    pub joined_at_seq: u64,
}

pub struct ConnectedPeer {
    pub peer_id: [u8; 16],
    pub pubkey: Option<Vec<u8>>,
    pub joined_at_seq: u64,
    pub tx: PeerTx,
}

/// A peer's outbound queue, bounded in **bytes** rather than frames.
///
/// A plain 512-slot channel of `Bytes` sounds bounded and is not: each slot
/// may hold a whole `max_frame_bytes` frame, so one peer that stops reading
/// can park 512 × 256 KiB = 128 MiB that no per-room or process log budget
/// accounts for. Frames in flight are not retained history, so the log budget
/// never sees them. Counting bytes here is what makes the process ceiling in
/// `LogBudget` an actual ceiling rather than an estimate.
#[derive(Clone)]
pub struct PeerTx {
    tx: mpsc::Sender<Bytes>,
    queued: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    max_bytes: usize,
}

impl PeerTx {
    pub fn new(tx: mpsc::Sender<Bytes>, max_bytes: usize) -> Self {
        PeerTx {
            tx,
            queued: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            max_bytes,
        }
    }

    /// A handle the reader uses to give bytes back as it drains them.
    pub fn meter(&self) -> QueueMeter {
        QueueMeter { queued: self.queued.clone() }
    }

    /// Non-blocking. `Err` means the peer is not keeping up and should be
    /// dropped — the same contract the raw channel's `try_send` had.
    pub fn try_send(&self, frame: Bytes) -> Result<(), PeerBacklogged> {
        let n = frame.len();
        if self.queued.fetch_add(n, Ordering::SeqCst) + n > self.max_bytes {
            self.queued.fetch_sub(n, Ordering::SeqCst);
            return Err(PeerBacklogged);
        }
        if self.tx.try_send(frame).is_err() {
            self.queued.fetch_sub(n, Ordering::SeqCst);
            return Err(PeerBacklogged);
        }
        Ok(())
    }

    /// Waits for room, so a log replay exerts real backpressure instead of
    /// dropping history on the floor. Gives up once the reader has clearly
    /// stopped draining.
    pub async fn send_backpressured(&self, frame: Bytes) -> Result<(), PeerBacklogged> {
        for _ in 0..600 {
            match self.try_send(frame.clone()) {
                Ok(()) => return Ok(()),
                Err(_) if self.tx.is_closed() => return Err(PeerBacklogged),
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        Err(PeerBacklogged)
    }

    #[cfg(test)]
    pub fn queued_bytes(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }
}

/// The peer is not keeping up and should be dropped.
#[derive(Debug, PartialEq, Eq)]
pub struct PeerBacklogged;

/// Held by the connection's read loop; returns quota as frames are written
/// out to the socket.
pub struct QueueMeter {
    queued: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl QueueMeter {
    pub fn release(&self, n: usize) {
        self.queued
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
                Some(cur.saturating_sub(n))
            })
            .ok();
    }
}

/// Per-room attempt limiter.
///
/// A sliding window, and deliberately nothing more. `record_failure` computes
/// an escalating backoff that is reported but never armed, and that is the
/// right call rather than an oversight:
///
/// The credential the server checks is SHA-256 over a 32-byte HKDF output, so
/// there is nothing here to brute-force directly. An attacker guessing
/// *passphrases* pays 64 MiB of Argon2id per attempt in their own browser
/// before they can even send one, and the window already caps them at five
/// per minute. An escalating lockout would therefore buy almost nothing
/// against an attacker — while handing anyone who knows a room id a way to
/// lock its actual occupants out for a quarter of an hour by failing auth on
/// purpose. The window is per room, so that cost lands on the wrong people.
struct AuthGuard {
    hits: Mutex<std::collections::VecDeque<Instant>>,
    max_per_min: u32,
}

impl AuthGuard {
    fn new(max_per_min: u32) -> Self {
        AuthGuard {
            hits: Mutex::new(std::collections::VecDeque::new()),
            max_per_min,
        }
    }

    fn allow(&self) -> bool {
        let mut hits = self.hits.lock().unwrap();
        let now = Instant::now();
        while hits.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            hits.pop_front();
        }
        if hits.len() >= self.max_per_min as usize {
            return false;
        }
        hits.push_back(now);
        true
    }

    /// Advisory only — see the note on `AuthGuard`. Reported so operators can
    /// see pressure on a room in the logs; not used to gate anything.
    fn record_failure(&self) -> Duration {
        let n = self.hits.lock().unwrap().len() as u64;
        Duration::from_secs(30u64.saturating_mul(n.saturating_sub(1).max(1)).min(15 * 60))
    }

    fn reset(&self) {
        self.hits.lock().unwrap().clear();
    }
}

pub struct Room {
    pub max_peers: usize,
    pub id: [u8; 16],
    pub class: RoomClass,
    pub state: Mutex<RoomState>,
    pub created_unix: u64,
    pub ttl: Ttl,
    pub ceiling_optout: bool,
    pub last_edit: Mutex<Instant>,
    pub last_peer_left: Mutex<Instant>,
    pub verifier: Option<Secret<[u8; 32]>>,
    pub kdf_m_kib: u32,
    pub kdf_t: u32,
    pub kdf_p: u32,
    pub salt: [u8; 16],
    pub config_blob: Option<Bytes>,
    pub log: std::sync::RwLock<RoomLog>,
    pub peers: Mutex<Vec<ConnectedPeer>>,
    pub next_seq: AtomicU64,
    pub epoch: AtomicU32,
    pub ttl_extension_secs: AtomicU64,
    auth_guard: AuthGuard,
    purge_acks: Mutex<std::collections::HashMap<String, PurgeAckSet>>,
}

/// Acks for one request id, with the instant they were first seen so the
/// ledger can be swept. Unbounded growth here was a remote memory-exhaustion
/// vector: one peer could mint a new entry per frame, forever.
struct PurgeAckSet {
    peers: std::collections::HashSet<[u8; 16]>,
    /// The peers connected when this request's FIRST ack arrived.
    ///
    /// Quorum is measured against this, not against whoever happens to be
    /// connected when the last ack lands. Every peer wipes and disconnects
    /// immediately after acking, so a live-set comparison shrinks as the acks
    /// arrive and is satisfied by whoever happens to ack last — which is one
    /// peer, not consensus. Freezing the cohort also denies the inverse
    /// attack: a hostile peer cannot shrink the denominator by dropping
    /// sockets, because the honest peers are already in the cohort and still
    /// have to ack.
    cohort: std::collections::HashSet<[u8; 16]>,
    opened: Instant,
}

/// Hard caps on the purge-ack ledger. A request id is a client-chosen string;
/// nothing about it is trusted.
pub const MAX_PURGE_REQUEST_IDS: usize = 16;
pub const MAX_PURGE_REQUEST_ID_LEN: usize = 128;
const PURGE_ACK_TTL: Duration = Duration::from_secs(300);

/// A room may never be extended past this, no matter how many peers ask.
/// Without it a single peer could pin a room — and its log — in memory
/// forever by replaying TTL_EXTEND, which defeats the entire expiry model.
pub const MAX_TTL_EXTENSION_SECS: u64 = 720 * 3600;

#[derive(Debug, PartialEq, Eq)]
pub enum JoinError {
    Full,
    AuthLockedOut(Duration),
}

impl Room {
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: [u8; 16],
        class: RoomClass,
        created_unix: u64,
        ttl: Ttl,
        ceiling_optout: bool,
        verifier: Option<[u8; 32]>,
        kdf_m_kib: u32,
        kdf_t: u32,
        kdf_p: u32,
        salt: [u8; 16],
        config_blob: Option<Bytes>,
        log_max_bytes: u64,
        auth_max_per_min: u32,
        max_peers: usize,
    ) -> Self {
        Room::with_budget(
            id, class, created_unix, ttl, ceiling_optout, verifier, kdf_m_kib, kdf_t, kdf_p,
            salt, config_blob, log_max_bytes, auth_max_per_min, max_peers,
            LogBudget::unlimited(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_budget(
        id: [u8; 16],
        class: RoomClass,
        created_unix: u64,
        ttl: Ttl,
        ceiling_optout: bool,
        verifier: Option<[u8; 32]>,
        kdf_m_kib: u32,
        kdf_t: u32,
        kdf_p: u32,
        salt: [u8; 16],
        config_blob: Option<Bytes>,
        log_max_bytes: u64,
        auth_max_per_min: u32,
        max_peers: usize,
        budget: std::sync::Arc<LogBudget>,
    ) -> Self {
        let now = Instant::now();
        Room {
            id,
            class,
            state: Mutex::new(RoomState::Active),
            created_unix,
            ttl,
            ceiling_optout,
            last_edit: Mutex::new(now),
            last_peer_left: Mutex::new(now),
            verifier: verifier.map(|v| Secret::new(Box::new(v))),
            kdf_m_kib,
            kdf_t,
            kdf_p,
            salt,
            config_blob,
            log: std::sync::RwLock::new(RoomLog::with_budget(log_max_bytes, budget)),
            peers: Mutex::new(Vec::new()),
            max_peers,
            next_seq: AtomicU64::new(1),
            epoch: AtomicU32::new(0),
            ttl_extension_secs: AtomicU64::new(0),
            auth_guard: AuthGuard::new(auth_max_per_min),
            purge_acks: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub fn verifier_ref(&self) -> Option<&[u8; 32]> {
        self.verifier.as_ref().map(|s| s.expose_secret())
    }

    pub fn auth_allowed(&self) -> bool {
        self.auth_guard.allow()
    }

    pub fn record_auth_failure(&self) -> Duration {
        self.auth_guard.record_failure()
    }

    pub fn auth_success(&self) {
        self.auth_guard.reset();
    }

    pub fn peer_count(&self) -> usize {
        self.peers.lock().unwrap().len()
    }

    pub fn touch(&self) {
        *self.last_edit.lock().unwrap() = Instant::now();
    }

    pub fn add_peer(&self, pubkey: Option<Vec<u8>>, tx: PeerTx) -> Result<RosterEntry, JoinError> {
        let mut peers = self.peers.lock().unwrap();
        if peers.len() >= self.max_peers {
            return Err(JoinError::Full);
        }
        if !self.auth_allowed() {
            let backoff = self.record_auth_failure();
            return Err(JoinError::AuthLockedOut(backoff));
        }
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let entry = RosterEntry {
            peer_id: generate_peer_id(seq),
            pubkey: pubkey.clone(),
            joined_at_seq: seq,
        };
        peers.push(ConnectedPeer { peer_id: entry.peer_id, pubkey, joined_at_seq: seq, tx });
        Ok(entry)
    }

    pub fn remove_peer(&self, peer_id: &[u8; 16]) -> bool {
        let mut peers = self.peers.lock().unwrap();
        let before = peers.len();
        peers.retain(|p| p.peer_id != *peer_id);
        if peers.len() != before && peers.is_empty() {
            *self.last_peer_left.lock().unwrap() = Instant::now();
        }
        peers.len() != before
    }

    pub fn sender_for(&self, peer_id: &[u8; 16]) -> Option<PeerTx> {
        self.peers.lock().unwrap()
            .iter().find(|p| p.peer_id == *peer_id)
            .map(|p| p.tx.clone())
    }

    pub fn roster(&self) -> Vec<RosterEntry> {
        self.peers
            .lock()
            .unwrap()
            .iter()
            .map(|p| RosterEntry { peer_id: p.peer_id, pubkey: p.pubkey.clone(), joined_at_seq: p.joined_at_seq })
            .collect()
    }

    /// Fan out a **server-authored** frame verbatim. PROTOCOL.md amendment C
    /// is explicit that JOIN_ACK, PEER_JOIN, PEER_LEAVE, PURGE, ERROR and
    /// TTL_EXTEND are never enveloped — receivers read their JSON straight
    /// out of the body. `broadcast` would prepend 16 sender bytes and make
    /// that JSON unparseable, so event frames must come through here.
    pub async fn broadcast_event(&self, frame: &Bytes, exclude: Option<[u8; 16]>) {
        let peers = self.peers.lock().unwrap();
        let mut dead = Vec::new();
        for p in peers.iter() {
            if Some(p.peer_id) == exclude {
                continue;
            }
            if p.tx.try_send(frame.clone()).is_err() {
                dead.push(p.peer_id);
            }
        }
        drop(peers);
        for id in dead {
            self.remove_peer(&id);
        }
    }

    /// Fan out a relayed peer frame to every connected peer except the origin.
    /// The outbound copy carries a 16-byte sender envelope between header and
    /// body so that receivers can rebuild their AEAD (amendment C).
    pub async fn broadcast(&self, frame: &Bytes, sender: Option<[u8; 16]>) {
        let peers = self.peers.lock().unwrap();
        let mut dead = Vec::new();
        for p in peers.iter() {
            if Some(p.peer_id) == sender {
                continue;
            }
            let outbound = match sender {
                Some(sid) => envelop(frame, sid),
                None => frame.clone(),
            };
            if p.tx.try_send(outbound).is_err() {
                dead.push(p.peer_id);
            }
        }
        drop(peers);
        for id in dead {
            self.remove_peer(&id);
        }
    }

    /// A purge executes only when every currently-connected peer has
    /// acknowledged the same request id. There is deliberately no timeout:
    /// a lone hostile peer must never be able to destroy the shared copy,
    /// and the server holds no keys that would make premature destruction
    /// "safe". Fail-closed means fail-forever until real consensus.
    pub fn note_purge_ack(&self, request_id: &str, peer_id: [u8; 16]) -> PurgeAckStatus {
        if request_id.is_empty() || request_id.len() > MAX_PURGE_REQUEST_ID_LEN {
            return PurgeAckStatus::Pending;
        }
        // The quorum is measured against the peers connected *right now*, and
        // an ack only counts while its peer is still one of them. Previously
        // the ledger kept every ack forever and compared its size against a
        // live count, so one peer could bank acks from throwaway connections,
        // drop them to shrink the denominator, and purge a room whose other
        // occupants had never agreed to anything.
        let live: std::collections::HashSet<[u8; 16]> =
            self.peers.lock().unwrap().iter().map(|p| p.peer_id).collect();
        if !live.contains(&peer_id) {
            return PurgeAckStatus::Pending;
        }

        let mut acks = self.purge_acks.lock().unwrap();
        let now = Instant::now();
        acks.retain(|_, set| now.duration_since(set.opened) < PURGE_ACK_TTL);
        if !acks.contains_key(request_id) && acks.len() >= MAX_PURGE_REQUEST_IDS {
            // Full of unresolved votes: drop the oldest rather than grow.
            if let Some(oldest) =
                acks.iter().min_by_key(|(_, s)| s.opened).map(|(k, _)| k.clone())
            {
                acks.remove(&oldest);
            }
        }
        let set = acks.entry(request_id.to_string()).or_insert_with(|| PurgeAckSet {
            peers: std::collections::HashSet::new(),
            cohort: live.clone(),
            opened: now,
        });
        set.peers.insert(peer_id);
        if !set.cohort.is_empty() && set.cohort.is_subset(&set.peers) {
            PurgeAckStatus::AllAcked(request_id.to_string())
        } else {
            PurgeAckStatus::Pending
        }
    }

    /// Any single peer may extend the timer (spec §5.9.4). Extension pushes
    /// the effective deadline out without ever shortening it.
    pub fn extend_ttl(&self, add_secs: u64) -> u64 {
        // Clamp against the ceiling before mutating anything, so replaying the
        // frame cannot push the deadline out without limit.
        let mut granted = 0u64;
        let total = self
            .ttl_extension_secs
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
                granted = add_secs.min(MAX_TTL_EXTENSION_SECS.saturating_sub(cur));
                Some(cur.saturating_add(granted))
            })
            .map(|prev| prev.saturating_add(granted))
            .unwrap_or(0);
        if granted == 0 {
            return total;
        }
        match self.ttl.kind {
            TtlKind::IdleEdit => {
                let mut last = self.last_edit.lock().unwrap();
                *last = last
                    .checked_add(Duration::from_secs(granted.min(86_400)))
                    .unwrap_or(*last);
            }
            TtlKind::IdlePeers => {
                let mut last = self.last_peer_left.lock().unwrap();
                *last = Instant::now()
                    .checked_add(Duration::from_secs(granted.min(86_400)))
                    .unwrap_or(*last);
            }
            _ => {}
        }
        total
    }

    pub fn effective_ttl_secs(&self) -> u64 {
        self.ttl.secs.saturating_add(self.ttl_extension_secs.load(Ordering::SeqCst))
    }

    pub fn mark_state(&self, s: RoomState) {
        *self.state.lock().unwrap() = s;
    }

    pub fn current_state(&self) -> RoomState {
        *self.state.lock().unwrap()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PurgeAckStatus {
    AllAcked(String),
    Pending,
}

/// Peer ids are server-assigned and untrusted by clients (spec §5.3). A boot
/// nonce mixed with a monotonic counter keeps them unique without a global
/// allocator lock.
static BOOT_NONCE: std::sync::LazyLock<[u8; 8]> = std::sync::LazyLock::new(|| {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("system RNG unavailable");
    b
});

pub fn generate_peer_id(seq: u64) -> [u8; 16] {
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&*BOOT_NONCE);
    id[8..].copy_from_slice(&seq.to_be_bytes());
    id
}

pub fn envelop(frame: &Bytes, sender: [u8; 16]) -> Bytes {
    let mut out = Vec::with_capacity(frame.len() + 16);
    out.extend_from_slice(&frame[..32.min(frame.len())]);
    out.extend_from_slice(&sender);
    out.extend_from_slice(&frame[32.min(frame.len())..]);
    Bytes::from(out)
}

pub fn parse_header(buf: &[u8]) -> Option<Header> {
    Header::decode(buf)
}

#[derive(Debug, PartialEq, Eq)]
pub enum CreateError {
    IdUnavailable,
    NameTaken,
    NameInvalid(names::NameError),
    PassphraseRequired,
    /// The process-wide room budget is full. Rooms are pure RAM, so this is
    /// the backstop that keeps a shared host from being driven into the OOM
    /// killer by anyone who can reach the create endpoint.
    AtCapacity,
}

pub struct RoomRegistry {
    rooms: DashMap<[u8; 16], std::sync::Arc<Room>>,
    names: DashMap<String, [u8; 16]>,
    retired: DashMap<[u8; 16], std::time::Instant>,
    max_rooms: usize,
    max_retired: usize,
    log_budget: std::sync::Arc<LogBudget>,
}

impl Default for RoomRegistry {
    fn default() -> Self {
        RoomRegistry::with_limits(
            crate::config::DEFAULT_MAX_ROOMS,
            crate::config::DEFAULT_TOTAL_LOG_BYTES,
        )
    }
}

impl RoomRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(max_rooms: usize) -> Self {
        RoomRegistry::with_limits(max_rooms, crate::config::DEFAULT_TOTAL_LOG_BYTES)
    }

    pub fn with_limits(max_rooms: usize, total_log_bytes: u64) -> Self {
        RoomRegistry {
            rooms: DashMap::new(),
            names: DashMap::new(),
            retired: DashMap::new(),
            log_budget: std::sync::Arc::new(LogBudget::new(total_log_bytes)),
            max_rooms: max_rooms.max(1),
            // Retired ids exist only to stop id reuse; bound the tombstones
            // so they cannot become their own memory leak.
            max_retired: max_rooms.saturating_mul(8).max(1024),
        }
    }

    pub fn max_rooms(&self) -> usize {
        self.max_rooms
    }

    /// Live ciphertext held across every room, and the ceiling it is measured
    /// against. Exposed so operators can see the real number rather than
    /// reason about `max_rooms × max_log_bytes`.
    pub fn log_bytes_used(&self) -> u64 {
        self.log_budget.used()
    }

    pub fn log_bytes_max(&self) -> u64 {
        self.log_budget.max()
    }

    pub fn get(&self, id: &[u8; 16]) -> Option<std::sync::Arc<Room>> {
        self.rooms.get(id).map(|r| r.clone())
    }

    pub fn exists(&self, id: &[u8; 16]) -> bool {
        self.rooms.contains_key(id) || self.retired.contains_key(id)
    }

    #[cfg(test)]
    pub fn retired_contains(&self, id: &[u8; 16]) -> bool {
        self.retired.contains_key(id)
    }

    /// Unlisted room ids are **server-assigned**. Letting the caller name the
    /// id turned this endpoint into an existence oracle — 409 meant "that room
    /// is live", 201 meant "it is not" — which undid the care taken to hide
    /// exactly that on `/api/meta/id/{id}`. It also allowed squatting an id
    /// somebody else was about to use.
    #[allow(clippy::too_many_arguments)]
    pub fn create_unlisted(
        &self,
        ttl: Ttl,
        ceiling_optout: bool,
        verifier: [u8; 32],
        kdf_m: u32,
        kdf_t: u32,
        kdf_p: u32,
        salt: [u8; 16],
        config_blob: Option<Bytes>,
        log_max_bytes: u64,
        auth_max: u32,
        max_peers: usize,
    ) -> Result<std::sync::Arc<Room>, CreateError> {
        if self.rooms.len() >= self.max_rooms {
            return Err(CreateError::AtCapacity);
        }
        let mut id = random_room_id();
        for _ in 0..8 {
            if !self.exists(&id) {
                break;
            }
            id = random_room_id();
        }
        if self.exists(&id) {
            return Err(CreateError::IdUnavailable);
        }
        let room = std::sync::Arc::new(Room::with_budget(
            id,
            RoomClass::Unlisted,
            unix_now(),
            ttl,
            ceiling_optout,
            Some(verifier),
            kdf_m,
            kdf_t,
            kdf_p,
            salt,
            config_blob,
            log_max_bytes,
            auth_max,
            max_peers,
            self.log_budget.clone(),
        ));
        self.rooms.insert(id, room.clone());
        Ok(room)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_named(
        &self,
        name: &str,
        suffix: bool,
        ttl: Ttl,
        ceiling_optout: bool,
        verifier: [u8; 32],
        kdf_m: u32,
        kdf_t: u32,
        kdf_p: u32,
        salt: [u8; 16],
        config_blob: Option<Bytes>,
        log_max_bytes: u64,
        auth_max: u32,
        max_peers: usize,
    ) -> Result<(std::sync::Arc<Room>, String), CreateError> {
        let normalized = names::normalize(name);
        names::validate(&normalized).map_err(CreateError::NameInvalid)?;
        if self.rooms.len() >= self.max_rooms {
            return Err(CreateError::AtCapacity);
        }
        let final_name = if suffix {
            // Bounded search: the suffix space is 16 bits, so an unbounded
            // loop here is a request that never returns once it saturates.
            let mut found = None;
            for _ in 0..64 {
                let candidate = format!("{}-{}", normalized, random_suffix());
                if !self.names.contains_key(&candidate) {
                    found = Some(candidate);
                    break;
                }
            }
            match found {
                Some(c) => c,
                None => return Err(CreateError::NameTaken),
            }
        } else if self.names.contains_key(&normalized) {
            return Err(CreateError::NameTaken);
        } else {
            normalized.clone()
        };
        let id = random_room_id();
        let room = std::sync::Arc::new(Room::with_budget(
            id,
            RoomClass::Named(final_name.clone()),
            unix_now(),
            ttl,
            ceiling_optout,
            Some(verifier),
            kdf_m,
            kdf_t,
            kdf_p,
            salt,
            config_blob,
            log_max_bytes,
            auth_max,
            max_peers,
            self.log_budget.clone(),
        ));
        self.rooms.insert(id, room.clone());
        self.names.insert(final_name.clone(), id);
        Ok((room, final_name))
    }

    pub fn resolve_name(&self, name: &str) -> Option<(String, std::sync::Arc<Room>)> {
        let key = names::normalize(name);
        let id = *self.names.get(&key)?;
        let room = self.get(&id)?;
        Some((key, room))
    }

    pub fn sweep_candidates(
        &self,
        drain_grace: Duration,
        idle_ceiling: Duration,
    ) -> Vec<(std::sync::Arc<Room>, &'static str)> {
        let cutoff = std::time::Instant::now() - Duration::from_secs(7 * 24 * 3600);
        self.retired.retain(|_, t| *t > cutoff);
        let mut out = Vec::new();
        for entry in self.rooms.iter() {
            let room = entry.value();
            if matches!(room.current_state(), RoomState::Purging | RoomState::Dead) {
                continue;
            }
            let reason = match room.ttl.kind {
                TtlKind::Absolute => {
                    let deadline = room
                        .created_unix
                        .saturating_add(room.effective_ttl_secs());
                    (unix_now() >= deadline).then_some("ttl-expired")
                }
                TtlKind::IdleEdit => {
                    let idle = room.last_edit.lock().unwrap().elapsed();
                    (idle >= Duration::from_secs(room.effective_ttl_secs()))
                        .then_some("idle-expired")
                }
                TtlKind::IdlePeers => {
                    if room.peer_count() == 0 {
                        let idle = room.last_peer_left.lock().unwrap().elapsed();
                        let minimum = Duration::from_secs(room.effective_ttl_secs())
                            .max(drain_grace);
                        (idle >= minimum).then_some("idle-expired")
                    } else {
                        None
                    }
                }
                TtlKind::None => {
                    if !room.ceiling_optout
                        && room.peer_count() == 0
                        && room.last_edit.lock().unwrap().elapsed() >= idle_ceiling.max(drain_grace)
                    {
                        Some("idle-ceiling")
                    } else {
                        None
                    }
                }
            };
            if let Some(reason) = reason {
                out.push((room.clone(), reason));
            }
        }
        out
    }

    pub fn remove_room(&self, id: &[u8; 16]) -> Option<(std::sync::Arc<Room>, Option<String>)> {
        let removed = self.rooms.remove(id).map(|(_, r)| r);
        let name = removed.as_ref().and_then(|room| match &room.class {
            RoomClass::Named(n) => Some(n.clone()),
            RoomClass::Unlisted => None,
        });
        if let Some(n) = &name {
            self.names.remove(n);
        }
        if self.retired.len() >= self.max_retired {
            let cutoff = std::time::Instant::now() - Duration::from_secs(24 * 3600);
            self.retired.retain(|_, t| *t > cutoff);
        }
        self.retired.insert(*id, std::time::Instant::now());
        removed.map(|r| (r, name))
    }

    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    pub fn name_count(&self) -> usize {
        self.names.len()
    }
}

fn random_room_id() -> [u8; 16] {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("system RNG unavailable");
    b
}

fn random_suffix() -> String {
    let mut b = [0u8; 2];
    getrandom::fill(&mut b).expect("system RNG unavailable");
    format!("{:x}{:x}{:x}{:x}", b[0] >> 4, b[0] & 0xF, b[1] >> 4, b[1] & 0xF)
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room_with_ttl(kind: TtlKind, secs: u64) -> Room {
        Room::new(
            [9u8; 16],
            RoomClass::Unlisted,
            unix_now() - secs / 2,
            Ttl { kind, secs },
            false,
            Some([1u8; 32]),
            65536,
            3,
            1,
            [7u8; 16],
            None,
            32 * 1024 * 1024,
            5,
            32,
        )
    }

    #[test]
    fn extend_grows_effective_ttl_and_never_shrinks() {
        let r = room_with_ttl(TtlKind::Absolute, 3600);
        assert_eq!(r.effective_ttl_secs(), 3600);
        let after = r.extend_ttl(600);
        assert_eq!(after, 600);
        assert_eq!(r.effective_ttl_secs(), 4200);
        let after = r.extend_ttl(60);
        assert_eq!(after, 660);
        assert_eq!(r.effective_ttl_secs(), 4260);
    }

    #[test]
    fn idle_peers_extension_pushes_last_peer_left_forward() {
        let r = room_with_ttl(TtlKind::IdlePeers, 60);
        let before = *r.last_peer_left.lock().unwrap();
        r.extend_ttl(300);
        let after = *r.last_peer_left.lock().unwrap();
        assert!(after > before + Duration::from_secs(299));
        assert_eq!(r.peer_count(), 0);
        let registry = RoomRegistry::new();
        assert!(registry.sweep_candidates(Duration::from_secs(5), Duration::from_secs(12 * 3600)).is_empty());
    }
}

#[cfg(test)]
mod purge_ack_tests {
    use super::*;

    fn room() -> Room {
        Room::new(
            [3u8; 16],
            RoomClass::Unlisted,
            unix_now(),
            Ttl { kind: TtlKind::IdlePeers, secs: 3600 },
            false,
            Some([2u8; 32]),
            65536,
            3,
            1,
            [5u8; 16],
            None,
            32 * 1024 * 1024,
            5,
            32,
        )
    }

    fn connect(room: &Room) -> [u8; 16] {
        let (tx, rx) = mpsc::channel(8);
        // Hold the receiver open for the lifetime of the test.
        std::mem::forget(rx);
        room.add_peer(None, PeerTx::new(tx, 1 << 20)).unwrap().peer_id
    }

    #[test]
    fn lone_peer_can_never_trigger_purge_via_deadline_or_fake_ids() {
        let r = room();
        let hostile = connect(&r);
        let _honest = connect(&r);
        for _ in 0..50 {
            match r.note_purge_ack("invented-id", hostile) {
                PurgeAckStatus::Pending => {}
                PurgeAckStatus::AllAcked(_) => panic!("single ack must never satisfy quorum"),
            }
        }
    }

    #[test]
    fn purge_fires_only_when_every_connected_peer_acks_same_id() {
        let r = room();
        let a = connect(&r);
        let b = connect(&r);
        assert_eq!(r.note_purge_ack("req", a), PurgeAckStatus::Pending);
        assert_eq!(
            r.note_purge_ack("other-req", b),
            PurgeAckStatus::Pending,
            "different request id must not count"
        );
        assert_eq!(r.note_purge_ack("req", b), PurgeAckStatus::AllAcked("req".into()));
    }

    /// The bug this pins: acks used to be banked forever and compared against
    /// a live peer count taken at ack time, so one peer could approve from
    /// throwaway sockets, drop them to shrink the denominator, and destroy a
    /// room its remaining occupants had never voted on.
    #[test]
    fn banked_acks_from_departed_peers_do_not_form_a_quorum() {
        let r = room();
        let honest = connect(&r);
        let mut throwaways = Vec::new();
        for _ in 0..4 {
            throwaways.push(connect(&r));
        }
        for id in &throwaways {
            assert_eq!(r.note_purge_ack("consensus", *id), PurgeAckStatus::Pending);
        }
        // The attacker drops every socket but one.
        for id in throwaways.iter().skip(1) {
            r.remove_peer(id);
        }
        assert_eq!(
            r.note_purge_ack("consensus", throwaways[0]),
            PurgeAckStatus::Pending,
            "stale acks must not stand in for the honest peer's vote"
        );
        // Only the honest peer's own ack completes it.
        assert_eq!(
            r.note_purge_ack("consensus", honest),
            PurgeAckStatus::AllAcked("consensus".into())
        );
    }

    #[test]
    fn acks_from_peers_who_are_not_connected_are_ignored() {
        let r = room();
        let _a = connect(&r);
        assert_eq!(r.note_purge_ack("req", [0xEE; 16]), PurgeAckStatus::Pending);
    }

    #[test]
    fn request_id_ledger_is_bounded() {
        let r = room();
        let a = connect(&r);
        let _b = connect(&r);
        for i in 0..(MAX_PURGE_REQUEST_IDS * 8) {
            let _ = r.note_purge_ack(&format!("id-{i}"), a);
        }
        assert!(
            r.purge_acks.lock().unwrap().len() <= MAX_PURGE_REQUEST_IDS,
            "ledger must not grow without bound"
        );
        let long = "x".repeat(MAX_PURGE_REQUEST_ID_LEN + 1);
        assert_eq!(r.note_purge_ack(&long, a), PurgeAckStatus::Pending);
        assert!(!r.purge_acks.lock().unwrap().contains_key(&long));
    }

    #[test]
    fn ttl_extension_stops_at_the_ceiling() {
        let r = room();
        for _ in 0..100 {
            r.extend_ttl(MAX_TTL_EXTENSION_SECS);
        }
        assert_eq!(
            r.ttl_extension_secs.load(Ordering::SeqCst),
            MAX_TTL_EXTENSION_SECS,
            "extension must saturate, not accumulate"
        );
    }
}

#[cfg(test)]
mod scheduler_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn expired_absolute_ttl_room_is_swept_and_actually_removed() {
        let registry = RoomRegistry::new();
        let room = registry
            .create_unlisted(
                Ttl { kind: TtlKind::Absolute, secs: 0 },
                false,
                [1u8; 32],
                65536,
                3,
                1,
                [2u8; 16],
                None,
                1024 * 1024,
                5,
                32,
            )
            .unwrap();

        // The bug this pins: marking Purging before purge() made surtr
        // early-return forever, so rooms leaked until process restart.
        let candidates = registry.sweep_candidates(Duration::from_secs(60), Duration::from_secs(12 * 3600));
        assert_eq!(candidates.len(), 1);

        crate::surtr::purge(&registry, &room.id, "ttl-expired").await;
        assert!(registry.get(&room.id).is_none(), "room must be removed from the registry");
        assert!(registry.retired_contains(&room.id), "id must never be reissued");
    }
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[tokio::test]
    async fn the_outbound_queue_is_bounded_in_bytes_not_frames() {
        let (tx, rx) = mpsc::channel(512);
        let peer = PeerTx::new(tx, 4096);
        // Four 1 KiB frames fit; the fifth does not, even though the channel
        // has 508 free slots.
        for _ in 0..4 {
            assert!(peer.try_send(Bytes::from(vec![0u8; 1024])).is_ok());
        }
        assert!(peer.try_send(Bytes::from(vec![0u8; 1024])).is_err());
        assert_eq!(peer.queued_bytes(), 4096);

        // Draining returns quota.
        let meter = peer.meter();
        meter.release(2048);
        assert!(peer.try_send(Bytes::from(vec![0u8; 1024])).is_ok());
        drop(rx);
    }

    #[tokio::test]
    async fn a_closed_peer_stops_accepting_immediately() {
        let (tx, rx) = mpsc::channel(4);
        let peer = PeerTx::new(tx, 1 << 20);
        drop(rx);
        assert!(peer.try_send(Bytes::from_static(b"x")).is_err());
        assert!(peer.send_backpressured(Bytes::from_static(b"x")).await.is_err());
    }
}
