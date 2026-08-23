import { argon2id } from "hash-wasm";

export interface KdfResult {
  material: Uint8Array;
  degraded: boolean;
}

export const ARGON2_M_KIB = 65536;
export const ARGON2_T = 3;
export const ARGON2_P = 1;

export async function deriveFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  params?: { mKib?: number; t?: number; p?: number },
): Promise<KdfResult> {
  const mKib = params?.mKib ?? ARGON2_M_KIB;
  const t = params?.t ?? ARGON2_T;
  const p = params?.p ?? ARGON2_P;
  try {
    const material = await argon2id({
      password: passphrase,
      salt,
      iterations: t,
      parallelism: p,
      memorySize: mKib,
      hashLength: 32,
      outputType: "binary",
    });
    return { material, degraded: false };
  } catch {
    return pbkdf2Fallback(passphrase, salt);
  }
}

export async function pbkdf2Fallback(
  passphrase: string,
  salt: Uint8Array,
  iterations = 600_000,
): Promise<KdfResult> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return { material: new Uint8Array(bits), degraded: true };
}
