import { argon2id } from "hash-wasm";

export interface KdfResult {
  material: Uint8Array;
}

export const ARGON2_M_KIB = 65536;
export const ARGON2_T = 3;
export const ARGON2_P = 1;

/// Argon2id could not run in this browser.
///
/// There used to be a fallback to PBKDF2, flagged as "degraded" behind a red
/// banner. It could never produce a working shared room. The server records
/// Argon2id as the room's derivation whatever the creating browser actually
/// ran, so a room made on PBKDF2 derived a different key from every browser
/// that did have Argon2: nobody else could open it, and to them it looked like
/// a wrong passphrase. It also left a verifier on the server that costs far
/// less to brute-force offline than the one the room claimed to have. Refusing
/// is the only outcome that is not quietly worse.
export class KdfUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("ARGON2_UNAVAILABLE");
    this.name = "KdfUnavailableError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

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
    return { material };
  } catch (e) {
    throw new KdfUnavailableError(e);
  }
}
