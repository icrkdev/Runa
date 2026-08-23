use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;
use dashmap::DashMap;
use secrecy::{ExposeSecret, SecretBox as Secret};
use tokio::sync::mpsc;

use crate::bifrost::frame::Header;
use crate::runar::log::RoomLog;
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
    pub tx: mpsc::Sender<Bytes>,
}

struct AuthGuard {
    hits: Mutex<std::collections::VecDeque<Instant>>,
    locked_until: Mutex<Option<Instant>>,
    max_per_min: u32,
}

impl AuthGuard {
    fn new(max_per_min: u32) -> Self {
        AuthGuard {
            hits: Mutex::new(std::collections::VecDeque::new()),
            locked_until: Mutex::new(None),
            max_per_min,
        }
    }

    fn allow(&self) -> bool {
        let mut lock = self.locked_until.lock().unwrap();
        if let Some(t) = *lock {
            if Instant::now() < t {
                return false;
            }
            *lock = None;
        }
        drop(lock);
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

    fn record_failure(&self) -> Duration {
        let n = self.hits.lock().unwrap().len() as u64;
        Duration::from_secs(30u64.saturating_mul(n.saturating_sub(1).max(1)).min(15 * 60))
    }

    fn reset(&self) {
        self.hits.lock().unwrap().clear();
        *self.locked_until.lock().unwrap() = None;
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
    purge_acks: Mutex<std::collections::HashMap<String, std::collections::HashSet<[u8; 16]>>>,
}

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
            log: std::sync::RwLock::new(RoomLog::new(log_max_bytes)),
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

    pub fn add_peer(&self, pubkey: Option<Vec<u8>>, tx: mpsc::Sender<Bytes>) -> Result<RosterEntry, JoinError> {
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

    pub fn sender_for(&self, peer_id: &[u8; 16]) -> Option<tokio::sync::mpsc::Sender<Bytes>> {
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

    /// Fan out a frame to every connected peer except the origin. The outbound
    /// copy carries a 16-byte sender envelope between header and body so that
    /// receivers can rebuild their AEAD (docs/PROTOCOL.md amendment C).
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
    pub fn note_purge_ack(
        &self,
        request_id: &str,
        peer_id: [u8; 16],
        total_peers: usize,
    ) -> PurgeAckStatus {
        let mut acks = self.purge_acks.lock().unwrap();
        let set = acks.entry(request_id.to_string()).or_default();
        set.insert(peer_id);
        if set.len() >= total_peers.max(1) {
            PurgeAckStatus::AllAcked(request_id.to_string())
        } else {
            PurgeAckStatus::Pending
        }
    }

    /// Any single peer may extend the timer (spec §5.9.4). Extension pushes
    /// the effective deadline out without ever shortening it.
    pub fn extend_ttl(&self, add_secs: u64) -> u64 {
        let total = self
            .ttl_extension_secs
            .fetch_add(add_secs, Ordering::SeqCst)
            .saturating_add(add_secs);
        match self.ttl.kind {
            TtlKind::IdleEdit => {
                *self.last_edit.lock().unwrap() +=
                    Duration::from_secs(add_secs.min(86_400));
            }
            TtlKind::IdlePeers => {
                *self.last_peer_left.lock().unwrap() =
                    Instant::now() + Duration::from_secs(add_secs.min(86_400));
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
}

#[derive(Default)]
pub struct RoomRegistry {
    rooms: DashMap<[u8; 16], std::sync::Arc<Room>>,
    names: DashMap<String, [u8; 16]>,
    retired: DashMap<[u8; 16], std::time::Instant>,
}

impl RoomRegistry {
    pub fn new() -> Self {
        Self::default()
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

    #[allow(clippy::too_many_arguments)]
    pub fn create_unlisted(
        &self,
        id: [u8; 16],
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
        if self.exists(&id) {
            return Err(CreateError::IdUnavailable);
        }
        let room = std::sync::Arc::new(Room::new(
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
        let final_name = if suffix {
            loop {
                let candidate = format!("{}-{}", normalized, random_suffix());
                if !self.names.contains_key(&candidate) {
                    break candidate;
                }
            }
        } else if self.names.contains_key(&normalized) {
            return Err(CreateError::NameTaken);
        } else {
            normalized.clone()
        };
        let id = random_room_id();
        let room = std::sync::Arc::new(Room::new(
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

    #[test]
    fn lone_peer_can_never_trigger_purge_via_deadline_or_fake_ids() {
        let r = room();
        // Two peers are connected per roster; one hostile peer acks repeatedly
        // under invented request ids and waits past any conceivable timeout.
        for _ in 0..50 {
            match r.note_purge_ack("invented-id", [9u8; 16], 2) {
                PurgeAckStatus::Pending => {}
                PurgeAckStatus::AllAcked(_) => panic!("single ack must never satisfy quorum"),
            }
        }
    }

    #[test]
    fn purge_fires_only_when_every_connected_peer_acks_same_id() {
        let r = room();
        assert_eq!(
            r.note_purge_ack("req", [1u8; 16], 2),
            PurgeAckStatus::Pending
        );
        assert_eq!(
            r.note_purge_ack("other-req", [2u8; 16], 2),
            PurgeAckStatus::Pending,
            "different request id must not count"
        );
        assert_eq!(
            r.note_purge_ack("req", [2u8; 16], 2),
            PurgeAckStatus::AllAcked("req".into())
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
                [7u8; 16],
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
