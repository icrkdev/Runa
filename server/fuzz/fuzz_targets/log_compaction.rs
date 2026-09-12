#![no_main]
//! `RoomLog` under an arbitrary sequence of appends, compactions and reads.
//!
//! This is the one path in the server that *discards* data. `apply_snapshot`
//! drops every entry below a client-supplied index and rebases the log on a
//! blob the server never inspects, so a mistake here loses history rather than
//! merely rejecting a frame. Until now the fuzzer was pointed at
//! `Header::decode` and `names::validate` — a bounds-checked parser and a
//! charset check, both already covered by unit tests, and neither able to lose
//! anything.
//!
//! The invariants below are properties of the structure, not of any one call,
//! which is why a sequence is generated rather than a single input.
use libfuzzer_sys::fuzz_target;
use runa_server::bytes::Bytes;
use runa_server::runar::log::{LogBudget, LogEntry, RoomLog};
use std::sync::Arc;

const MAX_BYTES: u64 = 1 << 16;
const BUDGET: u64 = 1 << 17;

fn entry(seed: u8, len: usize) -> LogEntry {
    LogEntry {
        sender: [seed; 16],
        frame_type: seed,
        epoch: seed as u32,
        frame: Bytes::from(vec![seed; len]),
    }
}

fuzz_target!(|data: &[u8]| {
    let budget = Arc::new(LogBudget::new(BUDGET));
    let mut log = RoomLog::with_budget(MAX_BYTES, budget.clone());

    let mut cursor = 0usize;
    let mut prev_len = log.log_len();

    while cursor + 2 <= data.len() {
        let op = data[cursor];
        let arg = data[cursor + 1];
        cursor += 2;

        match op % 4 {
            0 => {
                let _ = log.append([arg; 16], arg, arg as u32, Bytes::from(vec![arg; arg as usize]));
            }
            1 => {
                // `covers` deliberately ranges well past log_len so the
                // rejection path is exercised as hard as the accepting one.
                let covers = u64::from(arg) % (log.log_len() + 4);
                let before_len = log.log_len();
                if log.apply_snapshot(covers, entry(arg, (arg as usize) % 64)) {
                    assert_eq!(
                        log.base_index(),
                        covers,
                        "an accepted snapshot must rebase the log exactly where it claimed",
                    );
                    assert_eq!(log.snapshot_covers(), covers);
                    // Compaction discards entries but never log positions: the
                    // indices below `covers` are represented by the snapshot,
                    // so the length of history cannot move.
                    assert_eq!(
                        log.log_len(),
                        before_len,
                        "compaction changed how long the log claims to be",
                    );
                }
            }
            2 => {
                let from = u64::from(arg) % (log.log_len() + 4);
                let chunk = log.tail_from(from);
                // A reader who asks from at or below the snapshot mark has to
                // be given the snapshot, or they rebuild from a gap.
                if log.has_snapshot() && from <= log.snapshot_covers() {
                    assert!(
                        chunk.snapshot.is_some(),
                        "tail_from({from}) below snapshot_covers({}) omitted the snapshot",
                        log.snapshot_covers(),
                    );
                }
                assert!(
                    chunk.entries.len() as u64 <= log.log_len(),
                    "tail returned more entries than the log contains",
                );
            }
            _ => {
                let _ = log.byte_size();
                let _ = log.has_snapshot();
            }
        }

        assert!(
            log.base_index() <= log.log_len(),
            "base_index {} ran past log_len {}",
            log.base_index(),
            log.log_len(),
        );
        assert!(
            log.snapshot_covers() <= log.log_len(),
            "snapshot claims to cover more than exists",
        );
        assert!(
            budget.used() <= budget.max(),
            "budget overdrawn: {} of {}",
            budget.used(),
            budget.max(),
        );
        assert!(
            log.log_len() >= prev_len,
            "the log went backwards: {} then {}",
            prev_len,
            log.log_len(),
        );
        prev_len = log.log_len();
    }
});
