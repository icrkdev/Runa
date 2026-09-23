import { describe, expect, it } from "vitest";
import { replaceRoster, rosterChanges, snapshotCover } from "./session";
import { rosterHash, type RosterEntry } from "./shred/roster";

// Peer ids and public keys are decoded from base64 on the way in, so the
// fixtures have to be real base64 of the right shape: 16 bytes for a peer id.
const pid = (name: string) => btoa(name.padEnd(16, "\u0000").slice(0, 16));
const PUBKEY = btoa("\u0000".repeat(32));
const ack = (names: string[]) =>
  names.map((n, i) => ({ peer_id: pid(n), pubkey: PUBKEY, joined_at_seq: i }));

describe("JOIN_ACK replaces the roster instead of merging into it", () => {
  it("drops peer ids the server no longer lists", () => {
    const roster = new Map<string, RosterEntry>();
    replaceRoster(roster, ack(["alice", "bob"]));
    expect([...roster.keys()]).toEqual([pid("alice"), pid("bob")]);

    // A reconnect: the same two people, but this client's connection has a new
    // peer id and so does the other side's. Merging kept all four.
    replaceRoster(roster, ack(["alice2", "bob2"]));
    expect([...roster.keys()]).toEqual([pid("alice2"), pid("bob2")]);
    expect(roster.size).toBe(2);
  });

  it("does not inflate the consensus denominator across repeated reconnects", () => {
    const roster = new Map<string, RosterEntry>();
    for (let i = 0; i < 5; i++) {
      replaceRoster(roster, ack([`alice${i}`, `bob${i}`]));
    }
    // Reported as "it wanted 3 of 4 to approve with 2 people in the room".
    expect(roster.size).toBe(2);
  });

  it("makes two clients agree on the roster hash, which gates every shred", async () => {
    // The hash travels inside a signed shred request and each receiver
    // re-derives it. A client that had reconnected hashed a bigger roster, so
    // every receiver rejected the request as roster-mismatch and showed no
    // prompt at all.
    const reconnected = new Map<string, RosterEntry>();
    replaceRoster(reconnected, ack(["a1", "b1"]));
    replaceRoster(reconnected, ack(["a2", "b2"]));

    const fresh = new Map<string, RosterEntry>();
    replaceRoster(fresh, ack(["a2", "b2"]));

    expect(await rosterHash([...reconnected.values()])).toBe(
      await rosterHash([...fresh.values()]),
    );
  });

  it("is empty when the server says the room is empty", () => {
    const roster = new Map<string, RosterEntry>();
    replaceRoster(roster, ack(["ghost"]));
    replaceRoster(roster, []);
    expect(roster.size).toBe(0);
  });
});

describe("the roster every PONG carries", () => {
  it("corrects a roster that missed a join and a leave, and nothing else", () => {
    const local = [pid("alice"), pid("ghost")];
    const { joined, left } = rosterChanges(local, ack(["alice", "bob"]));
    expect(joined.map((r) => r.peer_id)).toEqual([pid("bob")]);
    expect(left).toEqual([pid("ghost")]);
  });

  it("changes nothing when the two agree", () => {
    const { joined, left } = rosterChanges([pid("alice"), pid("bob")], ack(["bob", "alice"]));
    expect(joined).toEqual([]);
    expect(left).toEqual([]);
  });
});

describe("the index a snapshot claims to cover", () => {
  // The elected snapshotter is the member who has been there longest. Here it
  // has only read: 400 entries in the log, none of them its own.
  const reader = { watermark: 400, lastCovered: 0, baseIndex: 0, storedCount: 0 };

  it("is everything the copy holds, not only what its holder typed", () => {
    expect(snapshotCover({ indexed: true, ...reader })).toBe(400);
    // What it used to be, and still is against a server without indexes: an
    // index of zero compacts nothing, however long the room lives.
    expect(snapshotCover({ indexed: false, ...reader })).toBe(0);
  });

  it("does not move backwards after someone else's snapshot, which the server would refuse", () => {
    // Another member snapshotted to 300 and left; this one now holds 320.
    const after = { watermark: 320, lastCovered: 300, baseIndex: 0, storedCount: 5 };
    expect(snapshotCover({ indexed: true, ...after })).toBe(320);
    expect(snapshotCover({ indexed: false, ...after })).toBeLessThan(300);
  });

  it("is nothing at all when nothing new has arrived since the last one", () => {
    expect(snapshotCover({ indexed: true, watermark: 300, lastCovered: 300, baseIndex: 0, storedCount: 0 })).toBeNull();
  });
});
