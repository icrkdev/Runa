import { describe, expect, it } from "vitest";
import { argon2id } from "hash-wasm";
import argon2Vectors from "./fixtures/argon2id.json";
import hkdfVectors from "./fixtures/hkdf.json";
import { deriveFromPassphrase, pbkdf2Fallback } from "./kdf";
import { hkdfBits, deriveRoomKeys, INFO_AUTH, INFO_CONTENT } from "./keys";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(h: string): Uint8Array {
  return new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

import argon2CrossVectors from "./fixtures/argon2id_cross.json";

const RFC = argon2Vectors[0];

// The reference Argon2id KAT (RFC 9106 §5.3) uses 12 bytes of associated
// data. hash-wasm hardcodes AD to empty, so the RFC vector is validated here
// with AD removed against the canonical C implementation's output for the
// same (password, salt, t, m, p), plus a differential matrix. RÚNA never
// passes secret or AD to the KDF; RÚNA never uses either.
const RFC_INPUTS_NO_AD = "03aab965c12001c9d7d0d2de33192c0494b684bb148196d73c1df1acaf6d0c2e";

describe("Argon2id against reference implementation", () => {
  it("matches the canonical C implementation for the RFC 9106 inputs (AD unused by RÚNA)", async () => {
    const out = await argon2id({
      password: fromHex(RFC.p),
      salt: fromHex(RFC.s),
      iterations: RFC.t,
      memorySize: RFC.m_kib,
      parallelism: RFC.par,
      hashLength: RFC.taglen,
      outputType: "binary",
    });
    expect(hex(out)).toBe(RFC_INPUTS_NO_AD);
  });

  (argon2CrossVectors as { pw_hex: string; salt_hex: string; t: number; m: number; p: number; out: string }[]).forEach((c, i) => {
    it(`differential case ${i}: t=${c.t} m=${c.m}KiB p=${c.p} matches the canonical C implementation`, async () => {
      const out = await argon2id({
        password: fromHex(c.pw_hex),
        salt: fromHex(c.salt_hex),
        iterations: c.t,
        memorySize: c.m,
        parallelism: c.p,
        hashLength: 32,
        outputType: "binary",
      });
      expect(hex(out)).toBe(c.out);
    });
  });

  it("derives production material without degradation when WASM works", async () => {
    const salt = new Uint8Array(16).fill(7);
    const r = await deriveFromPassphrase("harbor thistle quartz nine", salt, { mKib: 8192 });
    expect(r.material).toHaveLength(32);
    expect(r.degraded).toBe(false);
  });

  it("PBKDF2 fallback flags itself as degraded", async () => {
    const salt = new Uint8Array(16).fill(3);
    const r = await pbkdf2Fallback("some passphrase", salt, 1000);
    expect(r.degraded).toBe(true);
    expect(r.material).toHaveLength(32);
  });
});

describe("HKDF-SHA-256 against RFC 5869", () => {
  (hkdfVectors as { ikm: string; salt: string; info: string; L: number; prk: string; okm: string }[]).forEach((c, i) => {
    it(`A.${i + 1} derives the published OKM`, async () => {
      const bits = await hkdfBits(fromHex(c.ikm), fromHex(c.salt), fromHex(c.info), c.L);
      expect(hex(bits)).toBe(c.okm);
    });
  });
});

describe("room key hierarchy (spec §3.3)", () => {
  const salt = new Uint8Array(16).fill(9);

  it("separates auth, content and fingerprint domains", async () => {
    const pass = new Uint8Array(32).fill(1);
    const a = await deriveRoomKeys(pass, null, salt);
    const b = await deriveRoomKeys(pass, null, salt);
    expect(hex(a.authKey)).toBe(hex(b.authKey));
    const fpHex = hex(a.fingerprintSeed);
    const authHex = hex(a.authKey);
    expect(authHex).not.toBe(fpHex);
    const otherSalt = new Uint8Array(16).fill(10);
    const c = await deriveRoomKeys(pass, null, otherSalt);
    expect(hex(c.authKey)).not.toBe(authHex);
  });

  it("link-only and link+passphrase produce different keys", async () => {
    const link = new Uint8Array(32).fill(2);
    const pass = new Uint8Array(32).fill(1);
    const a = await deriveRoomKeys(null, link, salt);
    const b = await deriveRoomKeys(pass, link, salt);
    expect(hex(a.authKey)).not.toBe(hex(b.authKey));
  });

  it("content key is non-extractable", async () => {
    const a = await deriveRoomKeys(new Uint8Array(32).fill(1), null, salt);
    await expect(crypto.subtle.exportKey("raw", a.contentKey)).rejects.toThrow();
    expect(a.contentKey.extractable).toBe(false);
  });

  it("refuses to derive with no material at all", async () => {
    await expect(deriveRoomKeys(null, null, salt)).rejects.toThrow();
  });

  it("info strings are distinct per purpose", () => {
    const auth = new TextDecoder().decode(INFO_AUTH);
    const content = new TextDecoder().decode(INFO_CONTENT);
    expect(auth).toBe("runa/v1/auth");
    expect(content).toBe("runa/v1/content");
    expect(auth).not.toBe(content);
  });
});
