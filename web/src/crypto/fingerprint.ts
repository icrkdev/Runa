import WORDLIST from "./wordlist2048.txt?raw";

export const WORDS: readonly string[] = WORDLIST.trim().split("\n").map((w) => w.trim());

if (WORDS.length !== 2048) {
  throw new Error(`wordlist must contain exactly 2048 words, found ${WORDS.length}`);
}

export const FP_WORD_COUNT = 6;

function bitsFrom(seed: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of seed) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  return bits;
}

function wordsFromBits(seed: Uint8Array, count: number, offset = 0): string[] {
  const bits = bitsFrom(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let idx = 0;
    for (let b = 0; b < 11; b++) {
      idx = (idx << 1) | (bits[offset + i * 11 + b] ?? 0);
    }
    out.push(WORDS[idx]);
  }
  return out;
}

export function fingerprintWords(fingerprintSeed: Uint8Array): string[] {
  return wordsFromBits(fingerprintSeed, FP_WORD_COUNT);
}

export function randomWordIndices(count: number): number[] {
  const raw = new Uint16Array(count);
  crypto.getRandomValues(raw);
  return Array.from(raw, (v) => v & 2047);
}

export function generateRoomName(withSuffix: boolean): string {
  const [a, b] = randomWordIndices(2);
  if (!withSuffix) return `${WORDS[a]}-${WORDS[b]}`;
  const suffixBytes = new Uint8Array(2);
  crypto.getRandomValues(suffixBytes);
  const hex4 = Array.from(suffixBytes)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${WORDS[a]}-${WORDS[b]}-${hex4.slice(0, 4)}`;
}

export function generateDicewarePassphrase(words = 4): string {
  const idx = randomWordIndices(words);
  return idx.map((i) => WORDS[i]).join(" ");
}
