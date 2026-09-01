import { concatBytes } from "./keys";

export const NONCE_SESS_LEN = 4;
export const COUNTER_LEN = 8;
export const TAG_LEN = 16;

/// The wire counter is 8 bytes. Its high 32 bits are a per-session random
/// prefix and its low 32 bits are the message sequence, so a session may send
/// 2^32 frames before it must rekey.
export const COUNTER_SEQ_BITS = 32n;
export const MAX_COUNTER = 1n << COUNTER_SEQ_BITS;

export class CounterExhaustedError extends Error {
  constructor() {
    super("nonce counter exhausted; rekey required");
  }
}

const encoder = new TextEncoder();

export function randomSessionId(): Uint8Array {
  const s = new Uint8Array(NONCE_SESS_LEN);
  crypto.getRandomValues(s);
  return s;
}

/// Every peer in a room encrypts under the *same* AES-GCM key, so the only
/// thing keeping two of them off the same nonce is the 12-byte
/// `sess || counter`. With a 4-byte session id and a counter that always
/// started at zero, the whole separation rested on 32 random bits — a
/// birthday collision after roughly 65 000 sessions, and a nonce collision in
/// AES-GCM is not a degradation, it is total: the XOR of the two plaintexts
/// falls out and the GHASH key leaks, which lets anyone forge frames.
///
/// Randomising the high half of the counter as well costs nothing on the wire
/// (the counter is already transmitted, already in the AAD) and lifts the
/// separation to 64 bits, moving the birthday bound out past 2^32 sessions.
export function randomCounterPrefix(): bigint {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return BigInt(b[0]);
}

export function counterToBytes(counter: bigint): Uint8Array {
  const b = new Uint8Array(COUNTER_LEN);
  let c = counter;
  for (let i = COUNTER_LEN - 1; i >= 0; i--) {
    b[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return b;
}

export function counterFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== COUNTER_LEN) throw new Error("counter must be 8 bytes");
  let c = 0n;
  for (let i = 0; i < COUNTER_LEN; i++) c = (c << 8n) | BigInt(bytes[i]);
  return c;
}

export function nonceFrom(sess: Uint8Array, counter: bigint): Uint8Array {
  if (sess.length !== NONCE_SESS_LEN) throw new Error("session id must be 4 bytes");
  return concatBytes(sess, counterToBytes(counter));
}

/// AAD binds every authenticated header field plus the relay envelope:
/// "runa/v1" || header(32B) || sender(16B) || counter(8B) || covers(8B).
/// The trailing covers word is zero except for SNAPSHOT frames, whose
/// truncation index therefore cannot be rewritten by a relay without
/// breaking authentication (PROTOCOL.md amendment B).
export function buildAad(
  header: Uint8Array,
  senderPeerId: Uint8Array,
  counter: bigint,
  covers = 0n,
): Uint8Array {
  if (header.length !== 32) throw new Error("header must be 32 bytes");
  return concatBytes(
    encoder.encode("runa/v1"),
    header,
    senderPeerId,
    counterToBytes(counter),
    counterToBytes(covers),
  );
}

export interface FrameEnvelope {
  sess: Uint8Array;
  counter: bigint;
  body: Uint8Array;
}

export class FrameCipher {
  readonly sess: Uint8Array;
  private readonly prefix: bigint;
  private seq = 0n;
  private peer: Uint8Array;

  constructor(
    readonly contentKey: CryptoKey,
    peerId: Uint8Array,
    sess?: Uint8Array,
    prefix?: bigint,
  ) {
    this.sess = sess ?? randomSessionId();
    this.prefix = prefix ?? randomCounterPrefix();
    this.peer = peerId;
  }

  get peerId(): Uint8Array {
    return this.peer;
  }

  get currentCounter(): bigint {
    return (this.prefix << COUNTER_SEQ_BITS) | this.seq;
  }

  /// Re-label the sender without disturbing the nonce stream. JOIN_ACK tells
  /// a client its server-assigned peer id, which the AAD must carry — but
  /// rebuilding the cipher to record it also reset the counter to zero while
  /// keeping the session id, so a second JOIN_ACK on the same socket would
  /// replay nonces that had already been used. A hostile relay could send
  /// that second frame whenever it liked, which is exactly the adversary the
  /// whole end-to-end design exists to stop.
  bindPeerId(peerId: Uint8Array): void {
    this.peer = peerId;
  }

  nextNonce(): { nonce: Uint8Array; counter: bigint } {
    if (this.seq >= MAX_COUNTER) throw new CounterExhaustedError();
    const counter = (this.prefix << COUNTER_SEQ_BITS) | this.seq;
    this.seq += 1n;
    return { nonce: nonceFrom(this.sess, counter), counter };
  }

  async encrypt(header: Uint8Array, plaintext: Uint8Array, covers = 0n): Promise<Uint8Array> {
    const { nonce, counter } = this.nextNonce();
    const aad = buildAad(header, this.peer, counter, covers);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce as BufferSource,
          additionalData: aad as BufferSource,
          tagLength: 128,
        },
        this.contentKey,
        plaintext as BufferSource,
      ),
    );
    aad.fill(0);
    nonce.fill(0);
    return concatBytes(this.sess, counterToBytes(counter), ct);
  }

  async decrypt(
    header: Uint8Array,
    senderPeerId: Uint8Array,
    envelope: Uint8Array,
    covers = 0n,
  ): Promise<Uint8Array> {
    if (envelope.length < NONCE_SESS_LEN + COUNTER_LEN + TAG_LEN) {
      throw new Error("envelope too short");
    }
    const sess = envelope.slice(0, NONCE_SESS_LEN);
    const counter = counterFromBytes(envelope.slice(NONCE_SESS_LEN, NONCE_SESS_LEN + COUNTER_LEN));
    const ct = envelope.slice(NONCE_SESS_LEN + COUNTER_LEN);
    return rawDecrypt(this.contentKey, header, senderPeerId, counter, covers, sess, ct);
  }
}

export async function decryptEnvelope(
  contentKey: CryptoKey,
  header: Uint8Array,
  senderPeerId: Uint8Array,
  envelope: Uint8Array,
  covers = 0n,
): Promise<Uint8Array> {
  if (envelope.length < NONCE_SESS_LEN + COUNTER_LEN + TAG_LEN) {
    throw new Error("envelope too short");
  }
  const sess = envelope.slice(0, NONCE_SESS_LEN);
  const counter = counterFromBytes(envelope.slice(NONCE_SESS_LEN, NONCE_SESS_LEN + COUNTER_LEN));
  const ct = envelope.slice(NONCE_SESS_LEN + COUNTER_LEN);
  return rawDecrypt(contentKey, header, senderPeerId, counter, covers, sess, ct);
}

async function rawDecrypt(
  contentKey: CryptoKey,
  header: Uint8Array,
  senderPeerId: Uint8Array,
  counter: bigint,
  covers: bigint,
  sess: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = nonceFrom(sess, counter);
  const aad = buildAad(header, senderPeerId, counter, covers);
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: 128,
      },
      contentKey,
      ciphertext as BufferSource,
    );
    return new Uint8Array(pt);
  } finally {
    nonce.fill(0);
    aad.fill(0);
  }
}

export async function decryptWithExplicitNonce(
  contentKey: CryptoKey,
  iv: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad: Uint8Array | undefined,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad?.length ? (aad as BufferSource) : undefined,
      tagLength: 128,
    },
    contentKey,
    ciphertextWithTag as BufferSource,
  );
  return new Uint8Array(pt);
}

export async function encryptWithExplicitNonce(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array | undefined,
): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad?.length ? (aad as BufferSource) : undefined,
      tagLength: 128,
    },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(ct);
}
