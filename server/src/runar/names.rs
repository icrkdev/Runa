use std::collections::HashSet;
use std::sync::LazyLock;

pub const MIN_NAME_LEN: usize = 3;
pub const MAX_NAME_LEN: usize = 64;

static RESERVED: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "admin", "administrator", "api", "app", "assets", "auth", "blog", "config",
        "contact", "dashboard", "dev", "docs", "gone", "help", "index", "info", "login",
        "logout", "me", "moderator", "new", "news", "nobody", "null", "root", "security",
        "settings", "signup", "socket", "status", "support", "system", "test", "undefined",
        "user", "users", "version", "www", "runa", "runar", "vardr", "heimdall", "bifrost",
        "surtr", "gjallarhorn", "ginnungagap",
    ]
    .into_iter()
    .collect()
});

#[derive(Debug, PartialEq, Eq)]
pub enum NameError {
    TooShort,
    TooLong,
    Charset,
    Reserved,
    SingleWord,
}

pub fn normalize(input: &str) -> String {
    input.trim().to_lowercase()
}

/// A name is valid if it is lowercase alphanumeric with hyphens, at least 3
/// characters, not reserved, and not a bare single word. Requiring either a
/// hyphen or a digit removes most dictionary-scanning value from the
/// namespace while keeping diceware-style names natural.
pub fn validate(name: &str) -> Result<(), NameError> {
    let n = normalize(name);
    if n.len() < MIN_NAME_LEN {
        return Err(NameError::TooShort);
    }
    if n.len() > MAX_NAME_LEN {
        return Err(NameError::TooLong);
    }
    if !n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(NameError::Charset);
    }
    if !n.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !n.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(NameError::Charset);
    }
    if RESERVED.contains(n.as_str()) {
        return Err(NameError::Reserved);
    }
    let has_hyphen = n.contains('-');
    let has_digit = n.contains(|c: char| c.is_ascii_digit());
    if !has_hyphen && !has_digit {
        return Err(NameError::SingleWord);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_diceware_names() {
        assert_eq!(validate("copper-lantern"), Ok(()));
        assert_eq!(validate("harbor-thistle-quartz-nine"), Ok(()));
        assert_eq!(validate("standup-4f2a"), Ok(()));
        assert_eq!(validate("  Copper-Lantern "), Ok(()));
    }

    #[test]
    fn rejects_single_dictionary_words() {
        assert_eq!(validate("standup"), Err(NameError::SingleWord));
        assert_eq!(validate("budget"), Err(NameError::SingleWord));
        assert_eq!(validate("notes"), Err(NameError::SingleWord));
    }

    #[test]
    fn digits_satisfy_uniqueness_requirement() {
        assert!(validate("room7").is_ok());
    }

    #[test]
    fn rejects_reserved_and_degenerate() {
        assert_eq!(validate("admin"), Err(NameError::Reserved));
        assert_eq!(validate("test"), Err(NameError::Reserved));
        assert_eq!(validate("ab"), Err(NameError::TooShort));
        assert_eq!(validate("-abc"), Err(NameError::Charset));
        assert_eq!(validate("abc-"), Err(NameError::Charset));
        assert_eq!(validate("hello world"), Err(NameError::Charset));
        assert_eq!(validate("Ünicode"), Err(NameError::Charset));
        let long = "a".repeat(65) + "-b";
        assert_eq!(validate(&long), Err(NameError::TooLong));
    }

    /// The invariant `server/fuzz/fuzz_targets/room_name.rs` asserts.
    /// Normalisation feeds the name registry, so a non-idempotent normalise
    /// would let one name occupy two registry keys.
    #[test]
    fn normalize_is_idempotent() {
        let cases = [
            "", " ", "  Copper-Lantern ", "\u{0130}stanbul", "\u{212A}elvin",
            "\u{00DF}trasse", "A\u{0301}CCENT", "\u{FF21}\u{FF22}",
            "\t mixed \u{00A0}Case\r\n", "\u{2028}line\u{2029}",
        ];
        for c in cases {
            let once = normalize(c);
            assert_eq!(once, normalize(&once), "normalize not idempotent for {c:?}");
        }
        // Every code point, one at a time: no lowercase mapping may introduce
        // leading or trailing whitespace.
        for cp in 0u32..=0x10FFFF {
            if let Some(ch) = char::from_u32(cp) {
                let once = normalize(&ch.to_string());
                if once != normalize(&once) {
                    panic!("normalize not idempotent for U+{cp:04X}");
                }
            }
        }
    }

    #[test]
    fn validate_agrees_with_itself_after_normalising() {
        for c in ["  Copper-Lantern ", "ROOM7", " admin ", "ab", "a-b-c-9"] {
            let n = normalize(c);
            assert_eq!(validate(c), validate(&n), "validate must be normalise-stable for {c:?}");
        }
    }

    #[test]
    fn reserved_names_cannot_pass_with_case_or_space() {
        assert_eq!(validate("ADMIN-"), Err(NameError::Charset));
        assert_eq!(validate(" admin "), Err(NameError::Reserved));
    }
}
