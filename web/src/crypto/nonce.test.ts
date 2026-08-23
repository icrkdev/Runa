import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FrameCipher, buildAad, counterToBytes, nonceFrom } from "./aead";
import { encodeHeader } from "../transport/frame";


const SAMPLE_HEADER = encodeHeader({
  version: 1, frameType: 3, roomId: new Uint8Array(16).fill(0x21),
  epoch: 0, nonceSess: new Uint8Array(4), flags: 0,
});

const SENDER = new Uint8Array(16).fill(0x34);

async function contentKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(9),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

describe("nonce uniqueness invariant (spec §3.6)", () => {
  it("never repeats a (key, sess, counter) triple under random interleavings", async () => {
    const key = await contentKey();
    const ciphers = [
      new FrameCipher(key, SENDER),
      new FrameCipher(key, SENDER),
      new FrameCipher(key, SENDER),
      new FrameCipher(key, SENDER),
    ];
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.nat(3), async (which) => {
        const env = await ciphers[which].encrypt(SAMPLE_HEADER, new Uint8Array([1]));
        const id = `${which}:${Array.from(env.slice(0, 12)).join(",")}`;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }),
      { numRuns: 2000 },
    );
    expect(seen.size).toBeGreaterThanOrEqual(2000);
  });

  it("sustains 10^5 encryptions with zero collisions in-suite; scripts/nonce-harness.mjs runs 10^7", async () => {
    const key = await contentKey();
    const cipher = new FrameCipher(key, SENDER);
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      const env = await cipher.encrypt(SAMPLE_HEADER, new Uint8Array([i & 0xff]));
      const first12 = Array.from(env.slice(0, 12)).join(",");
      expect(seen.has(first12)).toBe(false);
      seen.add(first12);
    }
    expect(seen.size).toBe(100_000);
  });
});

describe("counter encoding", () => {
  it("is big-endian over 64 bits", () => {
    expect(Array.from(counterToBytes(0n))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(counterToBytes(1n))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(counterToBytes(0xffn))).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
    expect(Array.from(counterToBytes(0x0100n))).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    const big = (1n << 48n) - 1n;
    expect(counterFromBack(big)).toBe(big);
  });

  function counterFromBack(c: bigint): bigint {
    let out = 0n;
    for (const b of counterToBytes(c)) out = (out << 8n) | BigInt(b);
    return out;
  }

  it("nonce is sess || counter", () => {
    const n = nonceFrom(new Uint8Array([1, 2, 3, 4]), 5n);
    expect(Array.from(n)).toEqual([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 5]);
  });

  it("AAD binds header + sender + counter + covers", () => {
    const aad = buildAad(SAMPLE_HEADER, SENDER, 0n);
    expect(aad.length).toBe(7 + 32 + 16 + 8 + 8);
  });
});
