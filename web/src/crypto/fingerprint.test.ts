import { describe, expect, it } from "vitest";
import { hkdfBits, INFO_FP } from "./keys";
import {
  fingerprintWords,
  generateDicewarePassphrase,
  generateRoomName,
  randomWordIndices,
  WORDS,
} from "./fingerprint";

const salt = new Uint8Array(16).fill(4);

async function fpSeed(material: number): Promise<Uint8Array> {
  return hkdfBits(new Uint8Array(32).fill(material), salt, INFO_FP, 32);
}

describe("room fingerprint (spec §3.3)", () => {
  it("derives exactly six words from the fixed 2048-word list", async () => {
    const words = fingerprintWords(await fpSeed(1));
    expect(words).toHaveLength(6);
    for (const w of words) expect(WORDS).toContain(w);
  });

  it("is deterministic for the same material and differs across material", async () => {
    const a = fingerprintWords(await fpSeed(1));
    const b = fingerprintWords(await fpSeed(1));
    const c = fingerprintWords(await fpSeed(2));
    expect(a).toEqual(b);
    expect(a.join(" ")).not.toBe(c.join(" "));
  });

  it("wordlist has exactly 2048 unique lowercase entries", () => {
    expect(WORDS).toHaveLength(2048);
    expect(new Set(WORDS).size).toBe(2048);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]+$/);
  });
});

describe("diceware generation (spec §3.9.2)", () => {
  it("generates speakable two-word names with an optional hex suffix", () => {
    for (let i = 0; i < 20; i++) {
      const withSuffix = generateRoomName(true);
      const without = generateRoomName(false);
      expect(withSuffix).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      expect(without).toMatch(/^[a-z]+-[a-z]+$/);
      expect(without.includes(" ")).toBe(false);
    }
  });

  it("generates four-word diceware passphrases of roughly 44 bits", () => {
    for (let i = 0; i < 10; i++) {
      const p = generateDicewarePassphrase(4);
      const words = p.split(" ");
      expect(words).toHaveLength(4);
      for (const w of words) expect(WORDS).toContain(w);
    }
  });

  it("random word indices stay in range", () => {
    for (let i = 0; i < 100; i++) {
      for (const idx of randomWordIndices(8)) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(2048);
      }
    }
  });
});

describe("awareness key format matches roster (review R-7)", () => {
  it("snapshot keys are base64-encoded peer ids", async () => {
    const { AwarenessHub } = await import("./../doc/awareness");
    const hub = await AwarenessHub.create(async () => {}, new Uint8Array(32).fill(1));
    const peerId = crypto.getRandomValues(new Uint8Array(16));
    hub.receive(peerId, new TextEncoder().encode(JSON.stringify({ h: "X", k: 0, l: 1, c: 1 })));
    const snap = hub.snapshot();
    expect(snap).toHaveLength(1);
    // The key must be base64, not comma-separated bytes
    expect(snap[0].senderId).not.toContain(",");
    expect(snap[0].senderId.length).toBeGreaterThan(0);
    // Round-trip: decode from base64 and compare to original
    const bin = atob(snap[0].senderId);
    const decoded = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
    expect(Array.from(decoded)).toEqual(Array.from(peerId));
  });
});
