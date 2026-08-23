use bytes::Bytes;

#[derive(Clone, Debug)]
pub struct LogEntry {
    pub sender: [u8; 16],
    pub frame_type: u8,
    pub epoch: u32,
    pub frame: Bytes,
}

#[derive(Debug)]
pub struct RoomLog {
    entries: Vec<LogEntry>,
    start_index: u64,
    snapshot: Option<LogEntry>,
    snapshot_covers: u64,
    total_bytes: u64,
    max_bytes: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AppendError {
    LogFull,
}

pub struct TailChunk {
    pub snapshot: Option<LogEntry>,
    pub entries: Vec<LogEntry>,
}

impl RoomLog {
    pub fn new(max_bytes: u64) -> Self {
        RoomLog {
            entries: Vec::new(),
            start_index: 0,
            snapshot: None,
            snapshot_covers: 0,
            total_bytes: 0,
            max_bytes,
        }
    }

    pub fn log_len(&self) -> u64 {
        self.start_index + self.entries.len() as u64
    }

    pub fn base_index(&self) -> u64 {
        self.start_index
    }

    pub fn byte_size(&self) -> u64 {
        self.total_bytes
    }

    pub fn has_snapshot(&self) -> bool {
        self.snapshot.is_some()
    }

    pub fn append(
        &mut self,
        sender: [u8; 16],
        frame_type: u8,
        epoch: u32,
        frame: Bytes,
    ) -> Result<u64, AppendError> {
        let entry_len = frame.len() as u64;
        if self.total_bytes + entry_len > self.max_bytes {
            return Err(AppendError::LogFull);
        }
        let index = self.log_len();
        self.total_bytes += entry_len;
        self.entries.push(LogEntry { sender, frame_type, epoch, frame });
        Ok(index)
    }

    /// A client-produced snapshot supersedes every log index below `covers`.
    /// The server verifies nothing about the blob; it only checks that the
    /// claim is monotonic, because rewinding the log would lose data.
    pub fn apply_snapshot(&mut self, covers: u64, snapshot_entry: LogEntry) -> bool {
        if covers < self.start_index || covers > self.log_len() {
            return false;
        }
        let drop_count = (covers - self.start_index) as usize;
        let dropped: Vec<LogEntry> = self.entries.drain(..drop_count).collect();
        for e in &dropped {
            self.total_bytes = self.total_bytes.saturating_sub(e.frame.len() as u64);
        }
        if let Some(old) = self.snapshot.replace(snapshot_entry) {
            self.total_bytes = self.total_bytes.saturating_sub(old.frame.len() as u64);
        }
        self.total_bytes += self.snapshot.as_ref().unwrap().frame.len() as u64;
        self.snapshot_covers = covers;
        self.start_index = covers;
        true
    }

    pub fn snapshot_entry(&self) -> Option<&LogEntry> {
        self.snapshot.as_ref()
    }

    pub fn snapshot_covers(&self) -> u64 {
        self.snapshot_covers
    }

    pub fn tail_from(&self, from_index: u64) -> TailChunk {
        let snapshot_needed = self.snapshot.is_some() && from_index <= self.snapshot_covers;
        let skip = from_index.saturating_sub(self.start_index) as usize;
        let entries = self.entries.iter().skip(skip).cloned().collect();
        TailChunk {
            snapshot: if snapshot_needed { self.snapshot.clone() } else { None },
            entries,
        }
    }

    /// Ciphertext buffers are dropped promptly here. They are not secret
    /// (spec §6.5); real wiping effort is spent on auth material in
    /// `heimdall::verifier`, which uses `Zeroizing`.
    pub fn drain_and_drop(&mut self) {
        drop(std::mem::take(&mut self.entries));
        drop(self.snapshot.take());
        self.total_bytes = 0;
        self.start_index = self.log_len();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(n: usize) -> Bytes {
        Bytes::from(vec![0xAB; n])
    }

    #[test]
    fn append_and_len() {
        let mut log = RoomLog::new(1000);
        assert_eq!(log.log_len(), 0);
        log.append([1; 16], 0x03, 0, frame(10)).unwrap();
        log.append([1; 16], 0x03, 0, frame(10)).unwrap();
        assert_eq!(log.log_len(), 2);
        assert_eq!(log.byte_size(), 20);
    }

    #[test]
    fn refuses_when_full() {
        let mut log = RoomLog::new(15);
        log.append([1; 16], 0x03, 0, frame(10)).unwrap();
        assert_eq!(log.append([1; 16], 0x03, 0, frame(10)), Err(AppendError::LogFull));
        assert_eq!(log.log_len(), 1);
    }

    #[test]
    fn snapshot_truncates_and_rebases() {
        let mut log = RoomLog::new(100_000);
        for _ in 0..5 {
            log.append([1; 16], 0x03, 0, frame(10)).unwrap();
        }
        assert!(log.apply_snapshot(3, LogEntry { sender: [2; 16], frame_type: 0x21, epoch: 0, frame: frame(50) }));
        assert_eq!(log.base_index(), 3);
        assert_eq!(log.log_len(), 5);
        assert_eq!(log.entries.len(), 2);
        assert_eq!(log.byte_size(), 50 + 20);

        let tail = log.tail_from(0);
        assert!(tail.snapshot.is_some());
        assert_eq!(tail.entries.len(), 2);

        let tail = log.tail_from(4);
        assert!(tail.snapshot.is_none());
        assert_eq!(tail.entries.len(), 1);

        let tail = log.tail_from(3);
        assert!(tail.snapshot.is_some());
        assert_eq!(tail.entries.len(), 2);
    }

    #[test]
    fn snapshot_rejects_rewind_and_future() {
        let mut log = RoomLog::new(100_000);
        for _ in 0..5 {
            log.append([1; 16], 0x03, 0, frame(10)).unwrap();
        }
        let snap = || LogEntry { sender: [2; 16], frame_type: 0x21, epoch: 0, frame: frame(10) };
        assert!(!log.apply_snapshot(9, snap()));
        assert!(!log.apply_snapshot(6, snap()));
        assert!(log.apply_snapshot(2, snap()));
        assert_eq!(log.base_index(), 2);
        assert!(!log.apply_snapshot(1, snap()));
        assert!(log.apply_snapshot(5, snap()));
        assert_eq!(log.log_len(), 5);
    }

    #[test]
    fn replacement_snapshot_accounts_bytes() {
        let mut log = RoomLog::new(100_000);
        for _ in 0..4 {
            log.append([1; 16], 0x03, 0, frame(10)).unwrap();
        }
        assert!(log.apply_snapshot(2, LogEntry { sender: [2; 16], frame_type: 0x21, epoch: 0, frame: frame(20) }));
        let after_first = log.byte_size();
        assert!(log.apply_snapshot(3, LogEntry { sender: [2; 16], frame_type: 0x21, epoch: 0, frame: frame(30) }));
        assert_eq!(log.byte_size(), after_first - 20 - 10 + 30);
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    use bytes::Bytes;

    fn frame(n: usize) -> Bytes {
        Bytes::from(vec![0xAB; n])
    }

    #[test]
    fn log_refuses_at_exactly_max_bytes() {
        let max = 1024u64;
        let mut log = RoomLog::new(max);
        // Exactly fill the log — must succeed
        let full_frame_size = (max / 2) as usize;
        log.append([1; 16], 0x03, 0, frame(full_frame_size)).unwrap();
        log.append([1; 16], 0x03, 0, frame(full_frame_size)).unwrap();
        assert_eq!(log.byte_size(), max);
        // One more byte must fail
        assert_eq!(
            log.append([1; 16], 0x03, 0, frame(1)),
            Err(AppendError::LogFull)
        );
    }

    #[test]
    fn log_accepts_at_one_byte_under_limit() {
        let mut log = RoomLog::new(100);
        log.append([1; 16], 0x03, 0, frame(99)).unwrap();
        assert_eq!(log.log_len(), 1);
        assert_eq!(log.byte_size(), 99);
    }
}
