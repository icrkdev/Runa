use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::error::WireCode;
use crate::heimdall::clientip::rate_limit_key;
use crate::heimdall::verifier;
use crate::runar::names;
use crate::runar::room::{unix_now, CreateError, Ttl, TtlKind};
use crate::AppState;

pub fn parse_room_hex(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    hex::decode(s).ok().and_then(|v| <[u8; 16]>::try_from(v).ok())
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    (status, Json(value)).into_response()
}

fn code_response(status: StatusCode, code: &str) -> Response {
    json_response(status, serde_json::json!({ "code": code }))
}

fn wire_code_response(status: StatusCode, code: WireCode) -> Response {
    json_response(status, serde_json::json!({ "code": u16::from(code) }))
}

/// Deterministic within a process (so the same missing room always sees the
/// same fake salt) but unpredictable across processes and to outsiders:
/// HMAC-SHA-256 under a boot-time secret key over the room id. A bare hash
/// of the id would let anyone compute it offline and probe existence.
pub fn dummy_salt_for(hmac_key: &[u8; 32], room_id: &[u8; 16]) -> [u8; 16] {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(hmac_key)
        .expect("HMAC accepts any key length");
    mac.update(room_id);
    let tag = mac.finalize().into_bytes();
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&tag[..16]);
    salt
}

#[derive(Serialize)]
struct MetaResponse {
    exists: bool,
    requires_auth: bool,
    kdf: KdfMeta,
}

#[derive(Serialize)]
struct KdfMeta {
    alg: &'static str,
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
}

/// Unlisted-room metadata is existence-hidden: a missing room returns the
/// identical shape filled with deterministic values derived from the id.
pub async fn meta_unlisted(
    State(state): State<AppState>,
    Path(room_hex): Path<String>,
) -> Response {
    tokio::time::sleep(state.cfg.auth_floor).await;
    let meta = match parse_room_hex(&room_hex).and_then(|id| state.rooms.get(&id)) {
        Some(room) => MetaResponse {
            exists: true,
            requires_auth: true,
            kdf: KdfMeta {
                alg: "argon2id",
                m_kib: room.kdf_m_kib,
                t: room.kdf_t,
                p: room.kdf_p,
                salt: B64.encode(room.salt),
            },
        },
        None => {
            let id = parse_room_hex(&room_hex).unwrap_or([0u8; 16]);
            MetaResponse {
                exists: true,
                requires_auth: true,
                kdf: KdfMeta {
                    alg: "argon2id",
                    m_kib: 65536,
                    t: 3,
                    p: 1,
                    salt: B64.encode(dummy_salt_for(&state.ghost_key, &id)),
                },
            }
        }
    };
    (StatusCode::OK, Json(meta)).into_response()
}

#[derive(Deserialize)]
pub struct ResolveBody {
    pub name: String,
}

pub async fn names_resolve(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ResolveBody>,
) -> Response {
    let ip = rate_limit_key(state.cfg.trusted_proxy, &headers, addr);
    if !state.name_lookup_ip.check(&ip) || !state.name_lookup_global.check(&"__global__".to_string()) {
        return wire_code_response(StatusCode::TOO_MANY_REQUESTS, WireCode::RateLimited);
    }
    if names::validate(&body.name).is_err() {
        return wire_code_response(StatusCode::BAD_REQUEST, WireCode::NameInvalid);
    }
    match state.rooms.resolve_name(&body.name) {
        Some((final_name, room)) => json_response(
            StatusCode::OK,
            serde_json::json!({
                "found": true,
                "name": final_name,
                "room_id": hex::encode(room.id),
                "requires_auth": true,
                "kdf": {
                    "alg": "argon2id",
                    "m_kib": room.kdf_m_kib,
                    "t": room.kdf_t,
                    "p": room.kdf_p,
                    "salt": B64.encode(room.salt),
                },
            }),
        ),
        None => json_response(StatusCode::OK, serde_json::json!({ "found": false })),
    }
}

#[derive(Deserialize)]
pub struct CreateRoomBody {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub suffix: Option<bool>,
    pub verifier: Option<String>,
    pub kdf: KdfBody,
    pub ttl: TtlBody,
    #[serde(default)]
    pub ceiling_optout: bool,
    #[serde(default)]
    pub config_blob: Option<String>,
}

#[derive(Deserialize)]
pub struct KdfBody {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    pub salt: String,
}

#[derive(Deserialize)]
pub struct TtlBody {
    pub kind: String,
    #[serde(default)]
    pub secs: u64,
}

struct ValidParams {
    verifier_key: [u8; 32],
    salt: [u8; 16],
    m: u32,
    t: u32,
    p: u32,
    ttl: Ttl,
    config_blob: Option<Vec<u8>>,
}

fn validate_params(body: &CreateRoomBody) -> Result<ValidParams, Box<Response>> {
    let ttl = Ttl {
        kind: match body.ttl.kind.as_str() {
            "absolute" => TtlKind::Absolute,
            "idle-edit" => TtlKind::IdleEdit,
            "idle-peers" => TtlKind::IdlePeers,
            "none" => TtlKind::None,
            _ => return Err(Box::new(code_response(StatusCode::BAD_REQUEST, "TTL_INVALID"))),
        },
        secs: body.ttl.secs,
    };
    let max_secs: u64 = 720 * 3600;
    if ttl.kind != TtlKind::None && (body.ttl.secs == 0 || body.ttl.secs > max_secs) {
        return Err(Box::new(code_response(StatusCode::BAD_REQUEST, "TTL_INVALID")));
    }
    if !(8192..=262144).contains(&body.kdf.m_kib)
        || !(1..=10).contains(&body.kdf.t)
        || !(1..=4).contains(&body.kdf.p)
    {
        return Err(Box::new(code_response(StatusCode::BAD_REQUEST, "KDF_INVALID")));
    }
    let salt: [u8; 16] = B64
        .decode(&body.kdf.salt)
        .ok()
        .and_then(|v| <[u8; 16]>::try_from(v).ok())
        .ok_or_else(|| Box::new(code_response(StatusCode::BAD_REQUEST, "KDF_INVALID")))?;
    let raw = body
        .verifier
        .as_deref()
        .and_then(|v| B64.decode(v).ok())
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .ok_or_else(|| Box::new(code_response(StatusCode::UNPROCESSABLE_ENTITY, "PASSPHRASE_REQUIRED")))?;
    if !verifier::plausible_verifier(&raw) {
        return Err(Box::new(code_response(StatusCode::BAD_REQUEST, "KDF_INVALID")));
    }
    let config_blob = body
        .config_blob
        .as_deref()
        .map(|c| B64.decode(c))
        .transpose()
        .map_err(|_| Box::new(code_response(StatusCode::BAD_REQUEST, "CONFIG_INVALID")))?;
    Ok(ValidParams { verifier_key: raw, salt, m: body.kdf.m_kib, t: body.kdf.t, p: body.kdf.p, ttl, config_blob })
}

pub async fn create_unlisted(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CreateRoomBody>,
) -> Response {
    let ip = rate_limit_key(state.cfg.trusted_proxy, &headers, addr);
    if !state.rooms_created.check(&ip) {
        return wire_code_response(StatusCode::TOO_MANY_REQUESTS, WireCode::RateLimited);
    }
    let Some(room_id) = body.id.as_deref().and_then(parse_room_hex) else {
        return code_response(StatusCode::BAD_REQUEST, "ID_INVALID");
    };
    let params = match validate_params(&body) {
        Ok(p) => p,
        Err(resp) => return *resp,
    };
    match state.rooms.create_unlisted(
        room_id,
        params.ttl,
        body.ceiling_optout,
        params.verifier_key,
        params.m,
        params.t,
        params.p,
        params.salt,
        params.config_blob.map(bytes::Bytes::from),
        state.cfg.max_log_bytes,
        state.cfg.auth_attempts_per_room_per_min,
        state.cfg.max_peers_per_room,
    ) {
        Ok(_) => json_response(
            StatusCode::CREATED,
            serde_json::json!({ "ok": true, "room_id": hex::encode(room_id) }),
        ),
        Err(CreateError::IdUnavailable) | Err(CreateError::NameTaken) => {
            code_response(StatusCode::CONFLICT, "UNAVAILABLE")
        }
        Err(CreateError::PassphraseRequired) | Err(CreateError::NameInvalid(_)) => {
            code_response(StatusCode::BAD_REQUEST, "PARAMS_INVALID")
        }
    }
}

pub async fn create_named(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CreateRoomBody>,
) -> Response {
    let ip = rate_limit_key(state.cfg.trusted_proxy, &headers, addr);
    if !state.named_created.check(&ip) {
        return wire_code_response(StatusCode::TOO_MANY_REQUESTS, WireCode::RateLimited);
    }

    // The hard rule: a named room cannot exist without a
    // passphrase-derived verifier — the name is public by construction,
    // so the passphrase is the only key. Enforced at the API with a test.
    let Some(raw_name) = body.name.as_deref().map(names::normalize) else {
        return wire_code_response(StatusCode::BAD_REQUEST, WireCode::NameInvalid);
    };
    if names::validate(&raw_name).is_err() {
        return wire_code_response(StatusCode::BAD_REQUEST, WireCode::NameInvalid);
    }
    if body.verifier.is_none() {
        return code_response(StatusCode::UNPROCESSABLE_ENTITY, "PASSPHRASE_REQUIRED");
    }
    let params = match validate_params(&body) {
        Ok(p) => p,
        Err(resp) => return *resp,
    };
    match state.rooms.create_named(
        &raw_name,
        body.suffix.unwrap_or(true),
        params.ttl,
        body.ceiling_optout,
        params.verifier_key,
        params.m,
        params.t,
        params.p,
        params.salt,
        params.config_blob.map(bytes::Bytes::from),
        state.cfg.max_log_bytes,
        state.cfg.auth_attempts_per_room_per_min,
        state.cfg.max_peers_per_room,
    ) {
        Ok((room, final_name)) => json_response(
            StatusCode::CREATED,
            serde_json::json!({
                "ok": true,
                "room_id": hex::encode(room.id),
                "name": final_name,
            }),
        ),
        Err(CreateError::NameTaken) | Err(CreateError::IdUnavailable) => {
            wire_code_response(StatusCode::CONFLICT, WireCode::NameTaken)
        }
        Err(CreateError::NameInvalid(_)) | Err(CreateError::PassphraseRequired) => {
            wire_code_response(StatusCode::BAD_REQUEST, WireCode::NameInvalid)
        }
    }
}

pub async fn version(State(state): State<AppState>) -> Response {
    json_response(
        StatusCode::OK,
        serde_json::json!({
            "commit": option_env!("RUNA_COMMIT").unwrap_or("dev"),
            "bundle_sha256": option_env!("RUNA_BUNDLE_SHA256").unwrap_or("dev"),
            "server_started": state.started_at,
            "now": unix_now(),
        }),
    )
}
