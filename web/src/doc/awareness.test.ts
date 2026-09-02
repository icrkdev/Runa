import { describe, expect, it } from "vitest";
import { AwarenessHub } from "./awareness";
import { toB64 } from "../transport/socket";

const presence = (handle: string) =>
  new TextEncoder().encode(JSON.stringify({ h: handle, k: 0, l: 1, c: 1 }));

describe("awareness peer keys share the roster's key space", () => {
  it("keys a peer by the same base64 id the roster uses", async () => {
    const hub = await AwarenessHub.create(async () => {}, new Uint8Array(32).fill(7));
    const peerId = crypto.getRandomValues(new Uint8Array(16));

    hub.receive(peerId, presence("BRONZE-ELM"));

    expect(hub.snapshot()[0].senderId).toBe(toB64(peerId));
    hub.dispose();
  });

  it("marks no live peer unreachable in the heartbeat comparison", async () => {
    const hub = await AwarenessHub.create(async () => {}, new Uint8Array(32).fill(7));
    const ids = Array.from({ length: 3 }, () =>
      crypto.getRandomValues(new Uint8Array(16)),
    );
    ids.forEach((id, i) =>
      hub.receive(id, presence(`PEER-${i}`)),
    );

    // Verbatim the comparison Session's heartbeat performs.
    const seen = new Set(hub.snapshot().map((s) => s.senderId));
    const unreachable = ids.filter((id) => !seen.has(toB64(id)));

    expect(unreachable).toHaveLength(0);
    hub.dispose();
  });
});

describe("presence frames are authenticated, not honest", () => {
  it("ignores the handle a peer claims for itself", async () => {
    // Every field here is written by another peer. They hold the room key so
    // the frame authenticates — but the shred dialog puts these names in
    // front of someone deciding whether to destroy shared work, so a peer
    // must not be able to broadcast another peer's name.
    const hub = await AwarenessHub.create(async () => {}, new Uint8Array(32).fill(7));
    const sender = new Uint8Array(16).fill(3);
    hub.receive(
      sender,
      new TextEncoder().encode(JSON.stringify({ h: "COPPER-LANTERN", k: 1, l: 1, c: 1 })),
    );
    const [entry] = hub.snapshot();
    expect(entry.state.handle).not.toBe("COPPER-LANTERN");

    // It is settable only by the session, which derives it from the public
    // key the server-assigned roster binds to this peer.
    hub.setHandle(entry.senderId, "REAL-NAME");
    expect(hub.snapshot()[0].state.handle).toBe("REAL-NAME");
  });

  it("discards a document hash that is not one", async () => {
    const hub = await AwarenessHub.create(async () => {}, new Uint8Array(32).fill(1));
    for (const bad of ["", "zzzz", "a".repeat(5000), "0123456789abcde", 42, null]) {
      hub.receive(
        new Uint8Array(16).fill(4),
        new TextEncoder().encode(JSON.stringify({ h: "x", k: 0, l: 1, c: 1, d: bad })),
      );
      expect(hub.foreignHashCounts().size).toBe(0);
    }
    hub.receive(
      new Uint8Array(16).fill(4),
      new TextEncoder().encode(JSON.stringify({ h: "x", k: 0, l: 1, c: 1, d: "0123456789abcdef" })),
    );
    expect(hub.foreignHashCounts().get("0123456789abcdef")).toBe(1);
  });

  it("clamps cursor coordinates instead of storing whatever arrives", async () => {
    const hub = await AwarenessHub.create(async () => {}, new Uint8Array(32).fill(2));
    hub.receive(
      new Uint8Array(16).fill(5),
      new TextEncoder().encode(
        JSON.stringify({ h: "x", k: 9999, l: -1, c: Number.MAX_SAFE_INTEGER }),
      ),
    );
    const s = hub.snapshot()[0].state;
    expect(s.colorIndex).toBeLessThanOrEqual(5);
    expect(s.line).toBeGreaterThanOrEqual(1);
    expect(s.column).toBeLessThanOrEqual(100_000);
  });
});
