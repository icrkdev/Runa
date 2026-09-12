#![no_main]
//! Arbitrary JSON through the room-creation body and the validation behind it.
//!
//! The parse itself belongs to serde; what matters is that validation is
//! total — every shape it accepts has to be one the rest of the server can
//! rely on — and that it never accepts a parameter set the metadata endpoint
//! cannot answer for. That last one is a real disclosure: `/api/meta/id/{hex}`
//! answers for a room that does not exist with the canonical KDF parameters,
//! so a room accepted with any others would be distinguishable from a missing
//! one by its own metadata.
use libfuzzer_sys::fuzz_target;
use runa_server::bifrost::http::{validate_params, CreateRoomBody, KDF_M_KIB, KDF_P, KDF_T};
use runa_server::config::Config;

fuzz_target!(|data: &[u8]| {
    let Ok(body) = serde_json::from_slice::<CreateRoomBody>(data) else {
        return;
    };
    let cfg = Config::default();
    let Ok(params) = validate_params(&body, &cfg) else {
        return;
    };

    // Anything accepted must be answerable by the metadata endpoint without
    // disclosing that the room exists.
    assert_eq!(params.m, KDF_M_KIB, "accepted a non-canonical m_kib");
    assert_eq!(params.t, KDF_T, "accepted a non-canonical t");
    assert_eq!(params.p, KDF_P, "accepted a non-canonical p");

    // And must be internally consistent for everything downstream.
    assert_eq!(params.salt.len(), 16);
    if params.ttl.kind != runa_server::runar::room::TtlKind::None {
        assert!(params.ttl.secs > 0, "a bounded TTL of zero would expire instantly");
        assert!(params.ttl.secs <= 720 * 3600, "TTL past the documented ceiling");
    }
});
