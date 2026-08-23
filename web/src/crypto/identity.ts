export type SignatureAlg = "Ed25519" | "ECDSA-P256";

export interface Identity {
  alg: SignatureAlg;
  keypair: CryptoKeyPair;
  publicKeyRaw: Uint8Array;
}

const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const ECDSA_P256_SPKI_PREFIX = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

export async function supportsEd25519(): Promise<boolean> {
  try {
    const k = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return !!k;
  } catch {
    return false;
  }
}

export async function generateIdentity(force?: SignatureAlg): Promise<Identity> {
  const alg: SignatureAlg = force ?? ((await supportsEd25519()) ? "Ed25519" : "ECDSA-P256");
  if (alg === "Ed25519") {
    const keypair = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keypair.publicKey));
    const publicKeyRaw = spki.slice(ED25519_SPKI_PREFIX.length);
    return { alg, keypair, publicKeyRaw };
  }
  const ecdsaGen: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
  const keypair = (await crypto.subtle.generateKey(
    ecdsaGen,
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keypair.publicKey));
  const publicKeyRaw = spki.slice(ECDSA_P256_SPKI_PREFIX.length);
  return { alg, keypair, publicKeyRaw };
}

function spkiFor(alg: SignatureAlg, raw: Uint8Array): Uint8Array {
  const prefix = alg === "Ed25519" ? ED25519_SPKI_PREFIX : ECDSA_P256_SPKI_PREFIX;
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix);
  out.set(raw, prefix.length);
  return out;
}

export async function importVerifyKey(
  alg: SignatureAlg,
  publicKeyRaw: Uint8Array,
): Promise<CryptoKey> {
  const spki = spkiFor(alg, publicKeyRaw);
  if (alg === "Ed25519") {
    return crypto.subtle.importKey("spki", spki as BufferSource, { name: "Ed25519" }, false, [
      "verify",
    ]);
  }
  const ecdsaImport: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };
  return crypto.subtle.importKey("spki", spki as BufferSource, ecdsaImport, false, [
    "verify",
  ]);
}

export async function signPayload(identity: Identity, payload: Uint8Array): Promise<Uint8Array> {
  if (identity.alg === "Ed25519") {
    return new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, identity.keypair.privateKey, payload as BufferSource),
    );
  }
  const ecdsaSign: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };
  return new Uint8Array(
    await crypto.subtle.sign(ecdsaSign, identity.keypair.privateKey, payload as BufferSource),
  );
}

export async function verifyPayload(
  alg: SignatureAlg,
  publicKeyRaw: Uint8Array,
  signature: Uint8Array,
  payload: Uint8Array,
): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await importVerifyKey(alg, publicKeyRaw);
  } catch {
    return false;
  }
  try {
    if (alg === "Ed25519") {
      return await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        signature as BufferSource,
        payload as BufferSource,
      );
    }
    const ecdsaVerify: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };
    return await crypto.subtle.verify(
      ecdsaVerify,
      key,
      signature as BufferSource,
      payload as BufferSource,
    );
  } catch {
    return false;
  }
}
