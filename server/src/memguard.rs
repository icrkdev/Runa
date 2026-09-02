#[cfg(target_os = "linux")]
mod imp {
    use anyhow::Result;
    use rlimit::Resource;

    /// Raw syscall wrappers over prctl(2) and mlockall(2). No pointers are
    /// dereferenced; the unsafe boundary exists solely to call libc.
    ///
    /// `mlockall` is what backs the threat model's claim that secrets are
    /// never written to swap. It needs either CAP_IPC_LOCK or a sufficient
    /// RLIMIT_MEMLOCK, and gets neither by default under `DynamicUser=yes` —
    /// so it used to fail with ENOMEM, silently, and the guarantee simply did
    /// not hold. That is survivable on a host with no swap and not otherwise.
    /// The failure is now loud: an operator who has swap enabled needs to
    /// know the lock did not take.
    #[allow(unsafe_code)]
    pub fn harden() -> Result<()> {
        rlimit::setrlimit(Resource::CORE, 0, 0)?;
        // SAFETY: both calls take scalars/constants and cannot cause UB.
        let (dumpable, locked) = unsafe {
            (
                libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0),
                libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE),
            )
        };
        if dumpable != 0 {
            tracing::warn!("PR_SET_DUMPABLE failed; a core dump could capture room keys");
        }
        if locked != 0 {
            let err = std::io::Error::last_os_error();
            tracing::warn!(
                error = %err,
                "mlockall failed: this process CAN be swapped to disk. If the host \
                 has swap enabled, room ciphertext and the room verifier may be \
                 written to it. Grant the service LimitMEMLOCK=infinity (see \
                 deploy/runa.service) or run the host without swap."
            );
        } else {
            tracing::info!("memory locked; this process will not be swapped");
        }
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use anyhow::Result;

    pub fn harden() -> Result<()> {
        Ok(())
    }
}

pub use imp::harden;
