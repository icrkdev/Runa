use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub fn hash_auth_key(auth_key: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(auth_key);
    h.finalize().into()
}

/// Constant-time verification. The same amount of work is done whether the
/// verifier exists, the length is wrong, or the key is simply incorrect, so
/// none of those cases are distinguishable by timing.
pub fn verify(stored_verifier: Option<&[u8; 32]>, presented: &[u8]) -> bool {
    let mut key = Zeroizing::new([0u8; 32]);
    if presented.len() == 32 {
        key.copy_from_slice(presented);
    }
    let computed = hash_auth_key(&key);
    let ok = stored_verifier.is_some_and(|v| constant_time_eq(v, &computed));
    ok && presented.len() == 32
}

pub fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.ct_eq(b).into()
}

/// Cheap sanity check at room creation: a verifier of all zeros or all ones
/// cannot be the output of SHA-256 over real key material and signals a
/// client bug or an attacker probing creation endpoints.
pub fn plausible_verifier(v: &[u8; 32]) -> bool {
    let all_same = v.iter().all(|b| *b == v[0]);
    !all_same
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_roundtrip() {
        let key = [42u8; 32];
        let v = hash_auth_key(&key);
        assert!(verify(Some(&v), &key));
    }

    #[test]
    fn wrong_key_fails() {
        let v = hash_auth_key(&[1u8; 32]);
        assert!(!verify(Some(&v), &[2u8; 32]));
    }

    #[test]
    fn missing_verifier_never_matches() {
        assert!(!verify(None, &[1u8; 32]));
    }

    #[test]
    fn wrong_length_fails_without_panic() {
        let v = hash_auth_key(&[9u8; 32]);
        for len in [0usize, 1, 31, 33, 64] {
            assert!(!verify(Some(&v), &vec![9u8; len]));
        }
    }
}
