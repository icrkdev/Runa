#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Some(header) = runa_server::bifrost::frame::Header::decode(data) {
        let reencoded = header.encode();
        assert_eq!(&reencoded[..], &data[..32]);
    }
});
