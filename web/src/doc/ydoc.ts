import * as Y from "yjs";
import { LogCursor } from "./cursor";

export interface TransportLike {
  sendUpdate(plaintext: Uint8Array): Promise<void>;
  sendSnapshot(plaintext: Uint8Array, covers: bigint): Promise<void>;
  sendSyncRequest(fromIndex: number): void;
}

export interface RunaDocOptions {
  transport: TransportLike;
  coalescingMs?: number;
  maxBufferBytes?: number;
  snapshotBytesThreshold?: number;
  snapshotCountThreshold?: number;
  snapshotIntervalMs?: number;
}

/// Wire privacy wrapper: u32 BE plaintext length, then the update,
/// then zero padding up to the next 256-byte bucket. Length-prefixing keeps
/// padding unambiguous (a CRDT update may legitimately end in 0x00).
export function wrapWithLengthAndPad(data: Uint8Array, bucket = 256): Uint8Array {
  const rem = (data.length + 4) % bucket;
  const padLen = rem === 0 ? 0 : bucket - rem;
  const out = new Uint8Array(4 + data.length + padLen);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out.set(data, 4);
  return out;
}

export function unwrapLengthPrefix(wrapped: Uint8Array): Uint8Array {
  if (wrapped.length < 4) throw new Error("payload shorter than length prefix");
  const view = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
  const len = view.getUint32(0, false);
  if (wrapped.length < 4 + len) throw new Error("length prefix exceeds payload");
  return wrapped.slice(4, 4 + len);
}

/// Merge several wrapped updates into one, for resending a backlog in fewer
/// frames. A Yjs merge is exact, so the result applies the same as the updates
/// it replaces.
export function mergeWrapped(items: Uint8Array[]): Uint8Array[] {
  if (items.length < 2) return items;
  return [wrapWithLengthAndPad(Y.mergeUpdates(items.map((w) => unwrapLengthPrefix(w))))];
}

export class RunaDoc {
  readonly ydoc = new Y.Doc();
  readonly text: Y.Text;
  updateCount = 0;
  baseIndex = 0;
  /// Entries this client has added to the room log since its last snapshot,
  /// as the transport reports them. Not updateCount, which counts local edits
  /// before they are merged or split for sending.
  storedCount = 0;
  /// Exactly which room-log entries this copy holds, against a server that
  /// sends indexes.
  readonly cursor = new LogCursor();

  private buffer: Uint8Array[] = [];
  private bufferedBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshotAt = Date.now();
  private destroyed = false;

  constructor(private opts: RunaDocOptions) {
    this.text = this.ydoc.getText("content");
    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || origin === "snapshot") return;
      this.queue(update);
    });
  }

  get value(): string {
    return this.text.toString();
  }

  setInitialContent(content: string): void {
    this.ydoc.transact(() => {
      this.text.insert(0, content);
    }, "local");
  }

  private queue(update: Uint8Array): void {
    if (this.destroyed) return;
    this.buffer.push(update);
    this.bufferedBytes += update.length;
    this.updateCount += 1;
    if (this.bufferedBytes >= (this.opts.maxBufferBytes ?? 16 * 1024)) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.opts.coalescingMs ?? 80);
    }
  }

  async flush(): Promise<void> {
    if (this.destroyed || !this.buffer.length) return;
    const pending = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const merged = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending);
    await this.opts.transport.sendUpdate(wrapWithLengthAndPad(merged));
  }

  applyRemote(wrapped: Uint8Array): void {
    Y.applyUpdate(this.ydoc, unwrapLengthPrefix(wrapped), "remote");
  }

  /// Resume from what this client has actually seen. Requesting from 0 on
  /// every reconnect replays the whole room log each time.
  syncFrom(): number {
    return this.baseIndex;
  }

  requestSync(): void {
    this.opts.transport.sendSyncRequest(this.baseIndex);
  }

  /// Ask for everything the room has, not just what this client has not seen.
  ///
  /// The ordinary request resumes from `baseIndex`, which is the right thing
  /// on a reconnect and the wrong thing when the document is already wrong:
  /// whatever was missed sits *below* that mark, so resuming from it asks for
  /// precisely the entries this client already has. From zero the server sends
  /// the snapshot and the whole tail, and Yjs discards what it already knows,
  /// so the cost of over-asking is bandwidth rather than correctness.
  resyncFromStart(): void {
    this.opts.transport.sendSyncRequest(0);
  }

  shouldSnapshot(logLen: bigint): boolean {
    const bytesOk = logLen > BigInt(this.opts.snapshotBytesThreshold ?? 2 * 1024 * 1024);
    const countOk = this.updateCount > (this.opts.snapshotCountThreshold ?? 2000);
    const timeOk = Date.now() - this.lastSnapshotAt > (this.opts.snapshotIntervalMs ?? 10 * 60_000);
    return bytesOk || countOk || timeOk;
  }

  /// Returns whether the snapshot was sent.
  async createSnapshot(logLen: bigint): Promise<boolean> {
    const state = Y.encodeStateAsUpdate(this.ydoc);
    try {
      await this.opts.transport.sendSnapshot(wrapWithLengthAndPad(state), logLen);
    } catch {
      // The server rejects snapshots from anyone but the elected peer. Moving
      // baseIndex anyway would make the next sync request start past history
      // the server still holds, and the missing updates never arrive.
      return false;
    }
    this.lastSnapshotAt = Date.now();
    this.updateCount = 0;
    this.storedCount = 0;
    this.baseIndex = Number(logLen);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ydoc.destroy();
  }
}
