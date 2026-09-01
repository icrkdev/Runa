import { describe, expect, it } from "vitest";
import gcmVectors from "./fixtures/gcm_aes256.json";
import {
  buildAad,
  counterFromBytes,
  counterToBytes,
  decryptWithExplicitNonce,
  encryptWithExplicitNonce,
  FrameCipher,
  MAX_COUNTER,
  nonceFrom,
} from "./aead";
import { encodeHeader, HEADER_LEN } from "../transport/frame";
import { decryptEnvelope } from "./aead";

const ROOM = new Uint8Array(16).fill(0x11);
function headerFor(ft: number): Uint8Array {
  return encodeHeader({
    version: 1,
    frameType: ft,
    roomId: ROOM,
    epoch: 0,
    nonceSess: new Uint8Array([9, 9, 9, 9]),
    flags: 0,
  });
}

function fromHex(h: string): Uint8Array {
  return new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function importAesKey(rawHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromHex(rawHex) as BufferSource,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

describe("AES-256-GCM against NIST CAVP vectors", () => {
  for (const [i, v] of gcmVectors.entries()) {
    const name = v.expect_fail
      ? `case ${i}: tampered ciphertext MUST fail authentication`
      : `case ${i}: encrypts to published ciphertext (${(v.pt?.length ?? 0) / 2} B pt)`;
    it(name, async () => {
      const key = await importAesKey(v.key);
      const iv = fromHex(v.iv);
      const aad = v.aad ? fromHex(v.aad) : undefined;
      if (v.expect_fail) {
        await expect(
          decryptWithExplicitNonce(key, iv, fromHex(`${v.ct}${v.tag}`), aad),
        ).rejects.toThrow();
      } else {
        const ct = await encryptWithExplicitNonce(key, iv, fromHex(v.pt!), aad);
        expect(hex(ct)).toBe(`${v.ct}${v.tag}`);
        const back = await decryptWithExplicitNonce(key, iv, fromHex(`${v.ct}${v.tag}`), aad);
        expect(hex(back)).toBe(v.pt!);
      }
    });
  }
});

const SENDER = new Uint8Array(16).fill(0x22);

function makeContentKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(5),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

describe("frame AEAD (spec §3.6)", () => {
  it("roundtrips arbitrary plaintext including empty and large frames", async () => {
    const key = await makeContentKey();
    const cipher = new FrameCipher(key, SENDER);
    for (const size of [0, 1, 255, 256, 4096, 256 * 1024]) {
      const pt = new Uint8Array(size);
      for (let off = 0; off < size; off += 65536) {
        crypto.getRandomValues(pt.subarray(off, Math.min(off + 65536, size)));
      }
      const env = await cipher.encrypt(headerFor(0x03), pt);
      const back = await cipher.decrypt(headerFor(0x03), SENDER, env);
      expect(back.length).toBe(size);
      expect(hex(back)).toBe(hex(pt));
    }
  });

  it("binds AAD so a frame cannot cross rooms, types or senders", async () => {
    const key = await makeContentKey();
    const cipher = new FrameCipher(key, SENDER);
    const pt = new TextEncoder().encode("canary");
    const env = await cipher.encrypt(headerFor(0x03), pt);

    const otherRoomHeader = encodeHeader({
      version: 1, frameType: 0x03,
      roomId: new Uint8Array(16).fill(0x33),
      epoch: 0, nonceSess: new Uint8Array([9, 9, 9, 9]), flags: 0,
    });
    await expect(cipher.decrypt(otherRoomHeader, SENDER, env)).rejects.toThrow();
    await expect(cipher.decrypt(headerFor(0x06), SENDER, env)).rejects.toThrow();

    const impostor = new Uint8Array(16).fill(0x44);
    await expect(cipher.decrypt(headerFor(0x03), impostor, env)).rejects.toThrow();

    const tampered = env.slice();
    tampered[tampered.length - 1] ^= 0x01;
    await expect(cipher.decrypt(headerFor(0x03), SENDER, tampered)).rejects.toThrow();
  });

  it("counter is strictly monotonic and encoded big-endian", async () => {
    const key = await makeContentKey();
    const cipher = new FrameCipher(key, SENDER, new Uint8Array([1, 2, 3, 4]));
    let prev = -1n;
    for (let i = 0; i < 100; i++) {
      const env = await cipher.encrypt(headerFor(0x03), new Uint8Array([1]));
      const c = counterFromBytes(env.slice(4, 12));
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
    expect(counterToBytes(0n)).toEqual(new Uint8Array(8));
    expect(counterToBytes(1n)[7]).toBe(1);
    expect(nonceFrom(new Uint8Array([9, 9, 9, 9]), 0n).length).toBe(12);
  });

  it("refuses to wrap past the rekey threshold", async () => {
    const key = await makeContentKey();
    const cipher = new FrameCipher(key, SENDER);
    (cipher as unknown as { seq: bigint }).seq = MAX_COUNTER;
    await expect(cipher.encrypt(headerFor(0x03), new Uint8Array(1))).rejects.toThrow(/rekey/);
  });

  it("distinct sessions never collide on (sess, counter)", async () => {
    const key = await makeContentKey();
    const a = new FrameCipher(key, SENDER);
    const b = new FrameCipher(key, SENDER);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const ea = await a.encrypt(headerFor(0x03), new Uint8Array([1]));
      const eb = await b.encrypt(headerFor(0x03), new Uint8Array([1]));
      seen.add(hex(ea.slice(0, 12)));
      seen.add(hex(eb.slice(0, 12)));
    }
    expect(seen.size).toBe(100);
  });
});

describe("AAD construction", () => {
  it("binds the full header + sender + counter + covers (amendment B/E)", () => {
    const aad = buildAad(headerFor(0x03), SENDER, 7n, 5n);
    expect(aad.length).toBe(7 + HEADER_LEN + 16 + 8 + 8);
    expect([...aad.slice(0, 7)]).toEqual([..."runa/v1"].map((c) => c.charCodeAt(0)));
    expect(aad[7 + 3]).toBe(0x03);
    expect(aad[aad.length - 9]).toBe(7);
    expect(aad[aad.length - 1]).toBe(5);
  });

  it("tampering with the epoch in the header breaks decryption", async () => {
    const key = await makeContentKey();
    const cipher = new FrameCipher(key, SENDER);
    const pt = new TextEncoder().encode("epoch test");
    const env = await cipher.encrypt(headerFor(0x03), pt);
    // Receiver sees a frame whose header claims a different epoch.
    const forgedHeader = encodeHeader({
      version: 1,
      frameType: 0x03,
      roomId: new Uint8Array(16).fill(0x11),
      epoch: 99,
      nonceSess: new Uint8Array([9, 9, 9, 9]),
      flags: 0,
    });
    await expect(
      decryptEnvelope(key, forgedHeader, SENDER, env),
    ).rejects.toThrow();
  });
});

describe("nonce separation (hardening)", () => {
  it("randomises the counter prefix so sessions are separated by 64 bits", async () => {
    const key = await makeContentKey();
    const prefixes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = new FrameCipher(key, SENDER);
      const env = await c.encrypt(headerFor(0x03), new Uint8Array([1]));
      // First frame of a session: bytes 4..8 are the random counter prefix.
      prefixes.add(Array.from(env.slice(4, 8)).join(","));
      // ...and the low half is the sequence, which does start at zero.
      expect(Array.from(env.slice(8, 12))).toEqual([0, 0, 0, 0]);
    }
    expect(prefixes.size).toBeGreaterThan(190);
  });

  it("re-binding the peer id does not rewind the nonce stream", async () => {
    const key = await makeContentKey();
    const cipher = new FrameCipher(key, SENDER);
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      seen.add(hex((await cipher.encrypt(headerFor(0x03), new Uint8Array([i]))).slice(0, 12)));
    }
    // What JOIN_ACK does now. Previously this constructed a fresh cipher with
    // the same sess and a counter back at zero.
    cipher.bindPeerId(new Uint8Array(16).fill(0x77));
    expect(cipher.peerId[0]).toBe(0x77);
    for (let i = 0; i < 5; i++) {
      const n = hex((await cipher.encrypt(headerFor(0x03), new Uint8Array([i]))).slice(0, 12));
      expect(seen.has(n)).toBe(false);
      seen.add(n);
    }
    expect(seen.size).toBe(10);
  });
});
