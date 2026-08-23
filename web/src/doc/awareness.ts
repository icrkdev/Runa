import { fingerprintWords } from "../crypto/fingerprint";

export interface PresenceState {
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
    const words = await wordsFromKey(publicKeyRaw);
    const handle = `${words[0].toUpperCase()}-${words[1].toUpperCase()}`;
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

  receive(senderId: Uint8Array, plaintext: Uint8Array): void {
    try {
      const j = JSON.parse(new TextDecoder().decode(plaintext)) as { h: string; k: number; l: number; c: number; d?: string };
      const key = Array.from(senderId).map((b) => String.fromCharCode(b)).join("");
      this.peers.set(btoa(key), {
        handle: j.h,
        colorIndex: j.k,
        line: j.l,
        column: j.c,
        docHash: j.d,
        updatedAt: Date.now(),
      });
      this.notify();
    } catch {
      return;
    }
  }

  foreignHashes(): Set<string> {
    const out = new Set<string>();
    for (const v of this.peers.values()) {
      if (v.docHash) out.add(v.docHash);
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

async function wordsFromKey(publicKeyRaw: Uint8Array): Promise<string[]> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyRaw as BufferSource));
  return fingerprintWords(digest);
}
