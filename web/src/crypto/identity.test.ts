import { describe, expect, it } from "vitest";
import ed25519Vectors from "./fixtures/ed25519.json";
import {
  generateIdentity,
  importVerifyKey,
  signPayload,
  supportsEd25519,
  verifyPayload,
  type SignatureAlg,
} from "./identity";

function fromHex(h: string): Uint8Array {
  return new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

describe("Ed25519 against RFC 8032 §7.1", () => {
  it("has Ed25519 support in this environment", async () => {
    expect(await supportsEd25519()).toBe(true);
  });

  for (const v of ed25519Vectors) {
    it(`test ${v.n}: signs the published message and verifies the published signature`, async () => {
      const sk = fromHex(ED25519_PKCS8_PREFIX + v.sk);
      const priv = await crypto.subtle.importKey(
        "pkcs8",
        sk as BufferSource,
        { name: "Ed25519" },
        false,
        ["sign"],
      );
      const msg = fromHex(v.msg);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, msg as BufferSource));
      expect(hex(sig)).toBe(v.sig);

      const pub = await importVerifyKey("Ed25519", fromHex(v.pk));
      const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, fromHex(v.sig) as BufferSource, msg as BufferSource);
      expect(ok).toBe(true);
    });
  }
});

describe("session identity", () => {
  it("generates Ed25519 by default with a 32-byte raw public key", async () => {
    const id = await generateIdentity();
    expect(id.alg).toBe("Ed25519");
    expect(id.publicKeyRaw).toHaveLength(32);
  });

  it("signs and verifies within a session", async () => {
    const id = await generateIdentity();
    const msg = new TextEncoder().encode("SHRED_REQUEST payload");
    const sig = await signPayload(id, msg);
    expect(await verifyPayload(id.alg, id.publicKeyRaw, sig, msg)).toBe(true);
    const tampered = msg.slice();
    tampered[0] ^= 0xff;
    expect(await verifyPayload(id.alg, id.publicKeyRaw, sig, tampered)).toBe(false);
    const badSig = sig.slice();
    badSig[badSig.length - 1] ^= 0x01;
    expect(await verifyPayload(id.alg, id.publicKeyRaw, badSig, msg)).toBe(false);
  });

  it("ECDSA P-256 fallback works end to end", async () => {
    const id = await generateIdentity("ECDSA-P256");
    expect(id.alg).toBe("ECDSA-P256");
    expect(id.publicKeyRaw).toHaveLength(65);
    expect(id.publicKeyRaw[0]).toBe(0x04);
    const msg = new TextEncoder().encode("vote");
    const sig = await signPayload(id, msg);
    expect(await verifyPayload(id.alg, id.publicKeyRaw, sig, msg)).toBe(true);
    expect(await verifyPayload("Ed25519", id.publicKeyRaw, sig, msg)).toBe(false);
  });

  it("rejects signatures from unknown keys", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const msg = new TextEncoder().encode("x");
    const sig = await signPayload(a, msg);
    const alg: SignatureAlg = "Ed25519";
    expect(await verifyPayload(alg, b.publicKeyRaw, sig, msg)).toBe(false);
    expect(await verifyPayload(alg, new Uint8Array(32).fill(1), sig, msg)).toBe(false);
  });
});
