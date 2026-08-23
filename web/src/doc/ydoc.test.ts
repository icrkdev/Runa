import { deltaToEdits } from "./binding";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import {
  buildFrame,
  FT,
  parseFrame,
  PROTOCOL_VERSION,
  snapshotCovers,
  stripEnvelope,
} from "../transport/frame";
import { RunaDoc, unwrapLengthPrefix, wrapWithLengthAndPad, type TransportLike } from "./ydoc";

describe("frame codec (spec §5.2)", () => {
  const roomId = new Uint8Array(16).map((_, i) => i);
  const sess = new Uint8Array([9, 8, 7, 6]);
  const payload = new Uint8Array([1, 2, 3]);

  it("encodes exact field offsets", () => {
    const f = buildFrame(FT.DOC_UPDATE, roomId, 42, sess, payload);
    expect(f.length).toBe(32 + 3);
    expect([...f.slice(0, 2)]).toEqual([0x52, 0x55]);
    expect(f[2]).toBe(PROTOCOL_VERSION);
    expect(f[3]).toBe(FT.DOC_UPDATE);
    expect([...f.slice(4, 20)]).toEqual([...roomId]);
    expect(new DataView(f.buffer).getUint32(20, false)).toBe(42);
    expect([...f.slice(24, 28)]).toEqual([9, 8, 7, 6]);
    expect(new DataView(f.buffer).getUint32(28, false)).toBe(0);
    expect([...f.slice(32)]).toEqual([1, 2, 3]);
  });

  it("roundtrips through the parser for every frame type", () => {
    for (const ft of Object.values(FT)) {
      const parsed = parseFrame(buildFrame(ft, roomId, 1, sess, payload));
      expect(parsed).not.toBeNull();
      expect(parsed!.header.frameType).toBe(ft);
      expect(parsed!.header.version).toBe(PROTOCOL_VERSION);
      expect(parsed!.body.length).toBe(3);
    }
  });

  it("rejects garbage without panicking", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 128 }), (bytes) => {
        expect(() => parseFrame(bytes)).not.toThrow();
        if (bytes.length >= 32 && bytes[0] === 0x52 && bytes[1] === 0x55) return;
        expect(parseFrame(bytes)).toBeNull();
      }),
    );
  });

  it("envelope strips sender id and body per protocol amendment C", () => {
    const frame = buildFrame(FT.DOC_UPDATE, roomId, 1, sess, payload);
    const sender = new Uint8Array(16).fill(7);
    const enveloped = new Uint8Array(frame.length + 16);
    enveloped.set(frame.slice(0, 32));
    enveloped.set(sender, 32);
    enveloped.set(frame.slice(32), 48);
    const out = stripEnvelope(enveloped);
    expect(out).not.toBeNull();
    expect([...out!.senderId]).toEqual([...sender]);
    expect([...out!.body]).toEqual([1, 2, 3]);
  });

  it("snapshot covers index reads big-endian u64", () => {
    const body = new Uint8Array(8 + 5);
    new DataView(body.buffer).setBigUint64(0, 0xdeadbeefn, false);
    expect(snapshotCovers(body)).toBe(0xdeadbeefn);
  });
});

function makeTransport() {
  const sent: Uint8Array[] = [];
  const transport: TransportLike = {
    async sendUpdate(pt) {
      sent.push(pt);
    },
    async sendSnapshot(pt, covers) {
      sent.push(new Uint8Array([0xff]), pt, new Uint8Array(Number(covers)));
    },
    sendSyncRequest() {},
  };
  return { transport, sent };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RunaDoc coalescing and snapshots (spec §5.4, §5.8)", () => {
  it("coalesces rapid local edits into one merged frame", async () => {
    const { transport, sent } = makeTransport();
    const doc = new RunaDoc({ transport, coalescingMs: 10 });
    doc.setInitialContent("");
    await doc.flush();
    const before = sent.length;
    doc.text.insert(0, "a");
    doc.text.insert(1, "b");
    doc.text.insert(2, "c");
    expect(sent.length).toBe(before);
    await sleep(30);
    expect(sent.length).toBe(before + 1);
    expect(doc.value).toBe("abc");
    doc.destroy();
  });

  it("wraps updates with an exact length prefix and 256-byte bucket padding", () => {
    expect(wrapWithLengthAndPad(new Uint8Array(251)).length).toBe(256);
    expect(wrapWithLengthAndPad(new Uint8Array(253)).length).toBe(512);
    const inner = new Uint8Array([0xde, 0xad, 0x00, 0xbe, 0xef]);
    const wrapped = wrapWithLengthAndPad(inner);
    expect([...unwrapLengthPrefix(wrapped)]).toEqual([0xde, 0xad, 0x00, 0xbe, 0xef]);
    expect(() => unwrapLengthPrefix(new Uint8Array(3))).toThrow();
    expect(() => unwrapLengthPrefix(new Uint8Array([0, 0, 0, 99, 1]))).toThrow();
  });

  it("flushes immediately when the buffer exceeds 16 KiB", async () => {
    const { transport, sent } = makeTransport();
    const doc = new RunaDoc({ transport, coalescingMs: 60_000, maxBufferBytes: 16 * 1024 });
    doc.setInitialContent("x".repeat(17_000));
    await sleep(5);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    doc.destroy();
  });

  it("snapshot trigger honours thresholds", () => {
    const { transport } = makeTransport();
    const doc = new RunaDoc({
      transport,
      snapshotIntervalMs: -1,
      snapshotCountThreshold: 2000,
      snapshotBytesThreshold: 2 * 1024 * 1024,
    });
    expect(doc.shouldSnapshot(100n)).toBe(true);
    const doc2 = new RunaDoc({ transport, snapshotIntervalMs: 60_000 });
    expect(doc2.shouldSnapshot(100n)).toBe(false);
    expect(doc2.shouldSnapshot(3n * 1024n * 1024n)).toBe(true);
    doc.destroy();
    doc2.destroy();
  });
});

describe("multi-peer convergence through coalescing relays (spec §10.2)", () => {
  class Bus {
    readonly entries: Uint8Array[] = [];
  }

  class Peer {
    readonly runa: RunaDoc;
    private delivered = 0;
    constructor(coalescingMs: number, bus: Bus) {
      this.runa = new RunaDoc({
        transport: {
          async sendUpdate(pt) {
            bus.entries.push(pt);
          },
          async sendSnapshot() {},
          sendSyncRequest() {},
        },
        coalescingMs,
      });
    }
    drain(bus: Bus): void {
      while (this.delivered < bus.entries.length) {
        this.runa.applyRemote(bus.entries[this.delivered]);
        this.delivered += 1;
      }
    }
  }

  async function converge(peers: Peer[], bus: Bus): Promise<void> {
    for (let round = 0; round < 6; round++) {
      await Promise.all(peers.map((p) => p.runa.flush()));
      const lenBefore = bus.entries.length;
      for (const p of peers) p.drain(bus);
      if (bus.entries.length === lenBefore) break;
    }
  }

  type Cmd =
    | { kind: "insert"; peerId: number; pos: number }
    | { kind: "delete"; peerId: number; pos: number; len: number }
    | { kind: "sync" };

  it("three peers converge on random concurrent interleavings", async () => {
    const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
      fc.nat(2).chain((peerId) => fc.nat(20).map((pos) => ({ kind: "insert" as const, peerId, pos }))),
      fc
        .nat(2)
        .chain((peerId) =>
          fc.nat(15).chain((pos) => fc.nat(5).map((len) => ({ kind: "delete" as const, peerId, pos, len }))),
        ),
      fc.constant({ kind: "sync" as const }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { maxLength: 120 }), async (cmds) => {
        const bus = new Bus();
        const peers = [new Peer(0, bus), new Peer(0, bus), new Peer(0, bus)];
        peers.forEach((p) => p.runa.setInitialContent(""));
        for (const cmd of cmds) {
          if (cmd.kind === "sync") {
            await converge(peers, bus);
            continue;
          }
          const doc = peers[cmd.peerId].runa;
          const len = doc.value.length;
          const pos = Math.min(cmd.pos, len);
          if (cmd.kind === "insert") {
            doc.text.insert(pos, String.fromCharCode(97 + (cmd.pos % 26)));
          } else if (len > 0) {
            const at = Math.min(pos, len - 1);
            doc.text.delete(at, Math.min(cmd.len, len - at));
          }
        }
        await converge(peers, bus);
        const texts = peers.map((p) => p.runa.value);
        expect(new Set(texts).size).toBe(1);
        peers.forEach((p) => p.runa.destroy());
      }),
      { numRuns: 40 },
    );
  });

  it("update application order does not affect the converged state", () => {
    const mkUpdate = (text: string): Uint8Array => {
      const d = new Y.Doc();
      d.getText("t").insert(0, text);
      return Y.encodeStateAsUpdate(d);
    };

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "c"), { minLength: 1, maxLength: 12 }),
        fc.array(fc.constantFrom("x", "y", "z"), { minLength: 1, maxLength: 12 }),
        (charsA, charsB) => {
          const ua = mkUpdate(charsA.join(""));
          const ub = mkUpdate(charsB.join(""));
          const left = new Y.Doc();
          Y.applyUpdate(left, ua);
          Y.applyUpdate(left, ub);
          const right = new Y.Doc();
          Y.applyUpdate(right, ub);
          Y.applyUpdate(right, ua);
          expect(left.getText("t").toString()).toBe(right.getText("t").toString());
        },
      ),
    );

  });
});

describe("deltaToEdits handles multi-line deltas (review #20)", () => {
  function applyDelta(text: string, delta: Array<{ retain?: number; delete?: number; insert?: string }>): string {
    type Edit = { start: number; end: number; text: string };
    const edits: Edit[] = [];
    let index = 0;
    for (const d of delta) {
      if (d.retain != null) { index += d.retain; }
      else if (d.delete != null) {
        edits.push({ start: index, end: index + d.delete, text: "" });
      } else if (d.insert != null) {
        edits.push({ start: index, end: index, text: d.insert });
        index += d.insert.length;
      }
    }
    edits.sort((a, b) => b.start - a.start);
    let result = text;
    for (const e of edits) {
      result = result.slice(0, e.start) + e.text + result.slice(e.end);
    }
    return result;
  }

  function lineCol(text: string, offset: number): { lineNumber: number; column: number } {
    const lines = text.slice(0, offset).split("\n");
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  it("deletion spanning a newline produces correct line/column", () => {
    const text = "line1\nline2";
    const edits = deltaToEdits(
      { delta: [{ retain: 5 }, { delete: 3 }] },
      (off) => lineCol(text, off),
      (sl, sc) => ({ sl, sc }),
    );
    expect(edits).toHaveLength(1);
    expect((edits[0].range as { sl: number }).sl).toBe(1);
    expect((edits[0].range as { sc: number }).sc).toBe(6);
  });

  it("insert containing newlines is placed at the right offset", () => {
    const edits = deltaToEdits(
      { delta: [{ retain: 2 }, { insert: "\nXX\n" }] },
      (off) => lineCol("ab\ncd", off),
      (sl, sc) => ({ sl, sc }),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("\nXX\n");
  });

  it("multi-line delete + insert round-trips through a plain-text model", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "alpha\nbeta\ngamma");

    // Apply the same logical operation to both Yjs and a plain string
    ytext.doc!.transact(() => {
      ytext.delete(5, 5);
      ytext.insert(5, "BETA\nDELTA");
    });
    const expected = applyDelta("alpha\nbeta\ngamma", [
      { retain: 5 }, { delete: 5 }, { insert: "BETA\nDELTA" },
    ]);
    expect(ytext.toString()).toBe(expected);
    expect(ytext.toString()).toBe("alphaBETA\nDELTA\ngamma");
    doc.destroy();
  });
});
