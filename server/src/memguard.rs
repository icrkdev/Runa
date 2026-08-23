#[cfg(target_os = "linux")]
mod imp {
    use anyhow::Result;
    use rlimit::Resource;

    /// Raw syscall wrappers over prctl(2) and mlockall(2). No pointers are
    /// dereferenced; the unsafe boundary exists solely to call libc.
    #[allow(unsafe_code)]
    pub fn harden() -> Result<()> {
        rlimit::setrlimit(Resource::CORE, 0, 0)?;
        // SAFETY: both calls take scalars/constants and cannot cause UB.
        unsafe {
            libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
            libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE);
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
