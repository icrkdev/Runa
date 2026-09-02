import { fingerprintWords } from "../crypto/fingerprint";

export interface PresenceState {
  /// Derived locally from the sender's roster public key — never taken from
  /// the message. See `receive`.
  handle: string;
  colorIndex: number;
  line: number;
  column: number;
  docHash?: string;
  updatedAt: number;
}

const PRESENCE_TIMEOUT_MS = 30_000;

export class AwarenessHub {
  private peers = new Map<string, PresenceState>();
  private listeners = new Set<() => void>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sendFn: (plaintext: Uint8Array) => Promise<void>,
    private ownHandle: string,
    private ownColorIndex: number,
  ) {
    this.pruneTimer = setInterval(() => {
      const cutoff = Date.now() - PRESENCE_TIMEOUT_MS;
      for (const [k, v] of this.peers) {
        if (v.updatedAt < cutoff) this.peers.delete(k);
      }
      this.notify();
    }, 5_000);
  }

  static async create(sendFn: (plaintext: Uint8Array) => Promise<void>, publicKeyRaw: Uint8Array): Promise<AwarenessHub> {
    const handle = await handleFromPubkey(publicKeyRaw);
    const raw = new Uint8Array(1);
    crypto.getRandomValues(raw);
    return new AwarenessHub(sendFn, handle, raw[0] % 6);
  }

  get handle(): string {
    return this.ownHandle;
  }

  get colorIndex(): number {
    return this.ownColorIndex;
  }

  async broadcastCursor(line: number, column: number, docHash?: string): Promise<void> {
    await this.sendFn(new TextEncoder().encode(JSON.stringify({
      h: this.ownHandle,
      k: this.ownColorIndex,
      l: line,
      c: column,
      d: docHash,
    })));
  }

  /// Everything in a presence frame is written by another peer. They hold the
  /// room key, so the frame authenticates — but authentic is not the same as
  /// honest, and the shred dialog now puts these handles in front of a person
  /// deciding whether to destroy shared work.
  ///
  /// The handle is therefore NOT taken from the message. It is derived from
  /// the sender's public key, which the server-assigned roster binds to their
  /// peer id, so nobody can broadcast someone else's name. The remaining
  /// fields are cosmetic and are clamped rather than trusted.
  receive(senderId: Uint8Array, plaintext: Uint8Array): void {
    try {
      const j = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
      const key = toKey(senderId);
      const existing = this.peers.get(key);
      this.peers.set(key, {
        handle: existing?.handle ?? key.slice(0, 6),
        colorIndex: clampInt(j.k, 0, 5),
        line: clampInt(j.l, 1, 10_000_000),
        column: clampInt(j.c, 1, 100_000),
        // A document hash is 16 hex characters. Anything else is discarded
        // rather than allowed to sit in the divergence tally.
        docHash: typeof j.d === "string" && /^[0-9a-f]{16}$/.test(j.d) ? j.d : undefined,
        updatedAt: Date.now(),
      });
      this.notify();
    } catch {
      return;
    }
  }

  /// Called by the session once it can bind a peer id to a roster public key.
  setHandle(senderIdB64: string, handle: string): void {
    const p = this.peers.get(senderIdB64);
    if (p) p.handle = handle;
  }

  /// How many peers report each document hash. Returning counts rather than a
  /// bare set is what lets the caller require agreement: a single peer
  /// broadcasting a made-up hash used to be enough to tell everyone else they
  /// had diverged, which is a cheap way to wear out a tamper warning until
  /// people stop reading it.
  foreignHashCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const v of this.peers.values()) {
      if (v.docHash) out.set(v.docHash, (out.get(v.docHash) ?? 0) + 1);
    }
    return out;
  }

  snapshot(): { senderId: string; state: PresenceState }[] {
    return [...this.peers.entries()].map(([senderId, state]) => ({ senderId, state }));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.listeners.clear();
    this.peers.clear();
  }
}

function toKey(senderId: Uint8Array): string {
  let s = "";
  for (const b of senderId) s += String.fromCharCode(b);
  return btoa(s);
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : lo;
  return Math.min(hi, Math.max(lo, n));
}

/// The two-word display name for a public key. Deriving it from the key is
/// what makes it unforgeable: the roster binds peer id to key, server-side.
export async function handleFromPubkey(publicKeyRaw: Uint8Array): Promise<string> {
  const words = await wordsFromKey(publicKeyRaw);
  return `${words[0].toUpperCase()}-${words[1].toUpperCase()}`;
}

async function wordsFromKey(publicKeyRaw: Uint8Array): Promise<string[]> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyRaw as BufferSource));
  return fingerprintWords(digest);
}
