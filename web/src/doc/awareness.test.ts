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
