#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = runa_server::runar::names::validate(&s.to_lowercase());
        let normalized = runa_server::runar::names::normalize(s);
        assert_eq!(normalized, runa_server::runar::names::normalize(&normalized));
    }
});
