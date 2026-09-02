/// Process hardening that must happen before anything sensitive exists.
///
/// The ordering constraint is awkward: hardening has to run before the first
/// allocation that could hold key material, but the log subscriber is not up
/// that early. Logging from inside `harden` therefore reaches nobody — which
/// is exactly how the silently-failing `mlockall` went unnoticed. So `harden`
/// reports what happened and `main` logs it once tracing is live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardeningReport {
    /// `mlockall` succeeded: this process will not be swapped.
    pub memory_locked: bool,
    /// Why it did not, if it did not.
    pub mlock_error: Option<String>,
    /// `PR_SET_DUMPABLE` succeeded: a core dump cannot capture room keys.
    pub dumps_disabled: bool,
    /// Platform has no equivalent; nothing was attempted.
    pub supported: bool,
}

impl HardeningReport {
    /// Call once the tracing subscriber exists.
    pub fn log(&self) {
        if !self.supported {
            tracing::warn!(
                "memory hardening is Linux-only; on this platform the process can be \
                 swapped and core-dumped. Fine for development, not for a deployment \
                 holding real documents."
            );
            return;
        }
        if !self.dumps_disabled {
            tracing::warn!("PR_SET_DUMPABLE failed; a core dump could capture room keys");
        }
        match (self.memory_locked, &self.mlock_error) {
            (true, _) => tracing::info!("memory locked; this process will not be swapped"),
            (false, err) => tracing::warn!(
                error = err.as_deref().unwrap_or("unknown"),
                "mlockall failed: this process CAN be swapped to disk. If the host has \
                 swap enabled, room ciphertext and the room verifier may be written to \
                 it. Grant the service LimitMEMLOCK=infinity (systemd) or \
                 --ulimit memlock=-1:-1 (docker), or run the host without swap."
            ),
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::HardeningReport;
    use anyhow::Result;
    use rlimit::Resource;

    /// Raw syscall wrappers over prctl(2) and mlockall(2). No pointers are
    /// dereferenced; the unsafe boundary exists solely to call libc.
    #[allow(unsafe_code)]
    pub fn harden() -> Result<HardeningReport> {
        rlimit::setrlimit(Resource::CORE, 0, 0)?;
        // SAFETY: both calls take scalars/constants and cannot cause UB.
        let (dumpable, locked) = unsafe {
            (
                libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0),
                libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE),
            )
        };
        Ok(HardeningReport {
            memory_locked: locked == 0,
            mlock_error: (locked != 0).then(|| std::io::Error::last_os_error().to_string()),
            dumps_disabled: dumpable == 0,
            supported: true,
        })
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::HardeningReport;
    use anyhow::Result;

    pub fn harden() -> Result<HardeningReport> {
        Ok(HardeningReport {
            memory_locked: false,
            mlock_error: None,
            dumps_disabled: false,
            supported: false,
        })
    }
}

pub use imp::harden;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harden_reports_rather_than_logging_into_the_void() {
        // The subscriber is not up when `harden` runs in main, so the result
        // has to be data. This is the regression: it used to log directly.
        let r = harden().expect("hardening must not fail the process");
        if cfg!(target_os = "linux") {
            assert!(r.supported);
            // Whether the lock takes depends on RLIMIT_MEMLOCK, so assert the
            // report is coherent rather than asserting an outcome.
            assert_eq!(r.memory_locked, r.mlock_error.is_none());
        } else {
            assert!(!r.supported);
        }
        r.log();
    }
}
