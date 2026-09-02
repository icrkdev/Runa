/// Raised from 40.
///
/// Forty bits is ample against the join endpoint, which allows five attempts
/// per room per minute. It is not the binding case. An attacker who reaches
/// the server captures three things at once: the room's ciphertext log, its
/// salt, and its verifier. From there the passphrase is ground offline at
/// whatever rate they can afford, and the room being ephemeral does not help
/// — they already hold the bytes.
///
/// Against Argon2id at 64 MiB / t=3, a serious farm managing ~10^5 guesses a
/// second clears a 40-bit space in about four months. Fifty bits puts the
/// same effort past three centuries. The Generate button produces five
/// diceware words (55 bits), so the default comfortably clears the new bar;
/// what this rejects is a four-word passphrase someone typed themselves.
export const MIN_PASSPHRASE_BITS = 50;

const CHAR_POOLS = [
  { re: /[a-z]/, bits: 26 },
  { re: /[A-Z]/, bits: 26 },
  { re: /[0-9]/, bits: 10 },
  { re: /[^a-zA-Z0-9]/, bits: 33 },
];

/// Compact common-password blocklist. Not exhaustive — the point is to
/// refuse the obvious candidates before the entropy estimate even runs.
const COMMON = new Set([
  "password", "password1", "password123", "123456789012", "qwertyuiop",
  "letmein123", "welcome1", "admin123", "master123", "login123",
]);

export interface PassphraseVerdict {
  ok: boolean;
  bits: number;
  dicewareWords: number;
}

export function estimatePassphrase(passphrase: string): PassphraseVerdict {
  const trimmed = passphrase.trim();
  const lower = trimmed.toLowerCase();
  if (lower && COMMON.has(lower.replace(/[0-9!@#$%^&*()]+$/, ""))) {
    return { ok: false, bits: 8, dicewareWords: 0 };
  }

  const words = trimmed.length ? trimmed.split(/[\s-]+/).filter(Boolean) : [];
  const allDiceware = words.length >= 3 && words.every((w) => /^[a-z]+$/.test(w.toLowerCase()));
  let bits: number;
  if (allDiceware) {
    bits = words.length * 11;
  } else if (words.length === 2 && words.every((w) => /^[a-z]+$/.test(w))) {
    bits = 2 * 11 - 1;
  } else if (words.length >= 1 && words.every((w) => /^[a-z]+$/.test(w))) {
    // All-lowercase single-word or short-word passphrases are dictionary-
    // attackable regardless of what a pool-size estimate claims.
    bits = Math.min(words.length * 11 - 4, trimmed.length);
  } else {
    let pool = 0;
    for (const p of CHAR_POOLS) if (p.re.test(passphrase)) pool += p.bits;
    const unique = new Set(passphrase).size;
    const effectiveLen = Math.min(passphrase.length, unique * 2 + 4);
    bits = passphrase.length === 0 ? 0 : effectiveLen * Math.log2(Math.max(pool, 2));
  }
  return {
    ok: bits >= MIN_PASSPHRASE_BITS,
    bits: Math.round(bits),
    dicewareWords: allDiceware ? words.length : 0,
  };
}
