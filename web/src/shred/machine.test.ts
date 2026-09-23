import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { generateIdentity, type Identity } from "../crypto/identity";
import { rosterHash, type RosterEntry } from "./roster";
import {
  cancelApplies, ShredMachine, supermajorityFor, type MachineHooks, type ShredVote } from "./machine";

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

interface Harness {
  machine: ShredMachine;
  identities: Map<string, Identity>;
  roster: RosterEntry[];
  hooks: MachineHooks & {
    approvals: string[];
    rejections: string[];
    expirations: string[];
    stalls: [string, string[]][];
    guardRejects: string[];
  };
}

async function makeHarness(peerCount: number): Promise<Harness> {
  const roster: RosterEntry[] = [];
  const identities = new Map<string, Identity>();
  for (let i = 0; i < peerCount; i++) {
    const identity = await generateIdentity();
    const peerIdB64 = toB64(new Uint8Array(16).fill(i + 1));
    identities.set(peerIdB64, identity);
    roster.push({ peerId: new Uint8Array(16).fill(i + 1), pubkey: identity.publicKeyRaw, joinedAtSeq: i + 1 });
  }
  const hooks = {
    approvals: [] as string[],
    rejections: [] as string[],
    expirations: [] as string[],
    stalls: [] as [string, string[]][],
    guardRejects: [] as string[],
    onApproved(id: string) { this.approvals.push(id); },
    onRejected(id: string) { this.rejections.push(id); },
    onExpired(id: string) { this.expirations.push(id); },
    onStalled(id: string, waiting: string[]) { this.stalls.push([id, waiting]); },
    onVoteRejectedByGuard(reason: string) { this.guardRejects.push(reason); },
  };
  const initiatorB64 = [...identities.keys()][0];
  const machine = new ShredMachine(identities.get(initiatorB64)!, initiatorB64, () => roster, hooks);
  return { machine, identities, roster, hooks };
}

describe("shred consensus machine fails closed (spec §5.6)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("unanimous approves only when every frozen-roster peer approves", async () => {
    const h = await makeHarness(3);
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    expect(h.machine.state).toBe("VOTING");
    const others = [...h.identities.keys()].slice(1);
    for (const [i, key] of others.entries()) {
      await h.machine.onVoteIncoming(await makeVote(h, key, req.requestId, "APPROVE"));
      const isLast = i === others.length - 1;
      expect(h.hooks.approvals.length).toBe(isLast ? 1 : 0);
      expect(h.machine.state).toBe(isLast ? "APPROVED" : "VOTING");
    }
    expect(h.machine.state).toBe("APPROVED");
    expect(h.hooks.approvals).toEqual([req.requestId]);
  });

  it("any reject ends a unanimous request immediately", async () => {
    const h = await makeHarness(4);
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    await h.machine.onVoteIncoming(await makeVote(h, [...h.identities.keys()][1], req.requestId, "APPROVE"));
    await h.machine.onVoteIncoming(await makeVote(h, [...h.identities.keys()][2], req.requestId, "REJECT"));
    expect(h.machine.state).toBe("REJECTED");
    expect(h.hooks.rejections).toEqual([req.requestId]);
    const late = await makeVote(h, [...h.identities.keys()][3], req.requestId, "APPROVE");
    await h.machine.onVoteIncoming(late);
    expect(h.hooks.approvals.length).toBe(0);
  });

  it("forged signatures are dropped with a warning, never counted", async () => {
    const h = await makeHarness(2);
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    const forged = await makeVote(h, [...h.identities.keys()][1], req.requestId, "APPROVE");
    forged.sig = forged.sig.slice(0, -4) + "AAAA";
    await h.machine.onVoteIncoming(forged);
    expect(h.machine.state).toBe("VOTING");
    expect(h.hooks.guardRejects).toContain("bad-signature");
  });

  it("duplicate votes are dropped", async () => {
    const h = await makeHarness(2);
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    const v1 = await makeVote(h, [...h.identities.keys()][1], req.requestId, "REJECT");
    await h.machine.onVoteIncoming(v1);
    const v2 = await makeVote(h, [...h.identities.keys()][1], req.requestId, "APPROVE");
    await h.machine.onVoteIncoming(v2);
    expect(h.machine.state).toBe("REJECTED");
    expect(h.machine.tally().approvals).toBe(1);
  });

  it("votes from peers outside the frozen roster never count", async () => {
    const h = await makeHarness(2);
    const outsider = await generateIdentity();
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    const vote: ShredVote = {
      type: "SHRED_VOTE",
      requestId: req.requestId,
      roomIdB64: "room",
      epoch: 0,
      voterPeerIdB64: toB64(outsider.publicKeyRaw.slice(0, 16)),
      voterPubKeyB64: toB64(outsider.publicKeyRaw),
      vote: "APPROVE",
      rosterHash: req.rosterHash,
      alg: outsider.alg,
      sig: "",
    };
    vote.sig = await signAs(outsider, vote);
    await h.machine.onVoteIncoming({ ...vote } as ShredVote);
    expect(h.machine.state).toBe("VOTING");
    expect(h.hooks.guardRejects).toContain("unknown-voter");
  });

  it("roster mismatch blocks a request outright", async () => {
    const h = await makeHarness(3);
    const attacker = await generateIdentity();
    const hiddenRoster = h.roster.slice(0, 2);
    const maliciousReq = {
      type: "SHRED_REQUEST" as const,
      requestId: "fake",
      roomIdB64: "room",
      epoch: 0,
      policy: "UNANIMOUS" as const,
      threshold: null,
      rosterHash: await rosterHash(hiddenRoster),
      initiatorPeerIdB64: [...h.identities.keys()][0],
      initiatorPubKeyB64: toB64(attacker.publicKeyRaw),
      alg: attacker.alg,
      issuedAt: Date.now(),
      deadlineMs: 60_000,
      sig: "",
    };
    const accepted = await h.machine.onRequestIncoming(maliciousReq);
    expect(accepted).toBe(false);
    expect(h.machine.state).toBe("IDLE");
  });

  it("deadline expiry fails closed", async () => {
    const h = await makeHarness(3);
    await h.machine.createRequest("room", 0, "MAJORITY", null, 5000);
    vi.advanceTimersByTime(6000);
    expect(h.machine.state).toBe("EXPIRED");
    expect(h.hooks.approvals.length).toBe(0);
  });

  it("unreachable peers stall unanimous requests instead of counting as approval", async () => {
    const h = await makeHarness(3);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    await h.machine.onVoteIncoming(await makeVote(h, keys[1], req.requestId, "APPROVE"));
    h.machine.markUnreachable(keys[2]);
    expect(h.machine.state).toBe("STALLED");
    expect(h.hooks.approvals.length).toBe(0);
    await h.machine.onVoteIncoming(await makeVote(h, keys[2], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("APPROVED");
  });

  it("majority policy passes at strictly more than half", async () => {
    const h = await makeHarness(4);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "MAJORITY", null, 60_000);
    await h.machine.onVoteIncoming(await makeVote(h, keys[1], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("VOTING");
    await h.machine.onVoteIncoming(await makeVote(h, keys[2], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("APPROVED");
  });

  it("threshold policy honours k", async () => {
    const h = await makeHarness(5);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "THRESHOLD", 4, 60_000);
    await h.machine.onVoteIncoming(await makeVote(h, keys[1], req.requestId, "APPROVE"));
    await h.machine.onVoteIncoming(await makeVote(h, keys[2], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("VOTING");
    await h.machine.onVoteIncoming(await makeVote(h, keys[3], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("APPROVED");
    const late = await makeVote(h, keys[4], req.requestId, "APPROVE");
    await h.machine.onVoteIncoming(late);
    expect(h.hooks.approvals.length).toBe(1);
  });

  it("refuses an INITIATOR request from an older or hostile peer", async () => {
    // The policy is gone from this build, but nothing stops a peer putting it
    // on the wire. Receiving one must not approve anything.
    const h = await makeHarness(3);
    const initiator = [...h.identities.keys()][1];
    const forged = {
      type: "SHRED_REQUEST",
      requestId: "forged",
      roomIdB64: "room",
      epoch: 0,
      policy: "INITIATOR",
      threshold: null,
      rosterHash: await rosterHash(h.roster),
      initiatorPeerIdB64: initiator,
      initiatorPubKeyB64: "",
      alg: "Ed25519",
      issuedAt: Date.now(),
      deadlineMs: 60_000,
      sig: "",
    } as unknown as Parameters<typeof h.machine.onRequestIncoming>[0];
    expect(await h.machine.onRequestIncoming(forged)).toBe(false);
    expect(h.hooks.approvals.length).toBe(0);
    expect(h.machine.state).toBe("IDLE");
  });

  it("refuses a THRESHOLD request whose bar is below a supermajority", async () => {
    // The bar rides inside the signed request, so a hostile initiator could
    // claim THRESHOLD(1) and shred alone. Each receiver checks the claim
    // against its own roster instead of trusting the number.
    const h = await makeHarness(6);
    const initiator = [...h.identities.keys()][1];
    const forged = {
      type: "SHRED_REQUEST",
      requestId: "low-bar",
      roomIdB64: "room",
      epoch: 0,
      policy: "THRESHOLD",
      threshold: 1,
      rosterHash: await rosterHash(h.roster),
      initiatorPeerIdB64: initiator,
      initiatorPubKeyB64: "",
      alg: "Ed25519",
      issuedAt: Date.now(),
      deadlineMs: 60_000,
      sig: "",
    } as unknown as Parameters<typeof h.machine.onRequestIncoming>[0];
    expect(await h.machine.onRequestIncoming(forged)).toBe(false);
    expect(h.hooks.approvals.length).toBe(0);
  });

  it("supermajority scales with the room instead of being a fixed 2", () => {
    // A fixed bar of 2 is minority rule in any room bigger than three, and
    // one person with two devices is two peers.
    expect(supermajorityFor(2)).toBe(2);
    expect(supermajorityFor(3)).toBe(2);
    expect(supermajorityFor(6)).toBe(4);
    expect(supermajorityFor(10)).toBe(7);
    expect(supermajorityFor(30)).toBe(20);
  });

  it("model check: no random sequence of valid/forged/duplicate/unreachable events ever destroys without meeting policy", async () => {
    const h = await makeHarness(4);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);

    const voteArb = fc.record({
      which: fc.nat(keys.length),
      kind: fc.constantFrom("approve", "reject", "forge", "duplicate", "unreachable", "heartbeat") as fc.Arbitrary<
        "approve" | "reject" | "forge" | "duplicate" | "unreachable" | "heartbeat"
      >,
    });

    await fc.assert(
      fc.asyncProperty(fc.array(voteArb, { maxLength: 40 }), async (cmds) => {
        const fresh = await makeHarness(4);
        const freshKeys = [...fresh.identities.keys()];
        const r = await fresh.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
        for (const cmd of cmds) {
          const voter = freshKeys[cmd.which % freshKeys.length];
          switch (cmd.kind) {
            case "approve":
              await fresh.machine.onVoteIncoming(await makeVote(fresh, voter, r.requestId, "APPROVE"));
              break;
            case "reject":
              await fresh.machine.onVoteIncoming(await makeVote(fresh, voter, r.requestId, "REJECT"));
              break;
            case "forge": {
              const v = await makeVote(fresh, voter, r.requestId, "APPROVE");
              v.sig = "QUFBQQ==";
              await fresh.machine.onVoteIncoming(v);
              break;
            }
            case "duplicate": {
              const v1 = await makeVote(fresh, voter, r.requestId, "APPROVE");
              await fresh.machine.onVoteIncoming(v1);
              break;
            }
            case "unreachable":
              fresh.machine.markUnreachable(voter);
              break;
            case "heartbeat":
              fresh.machine.noteHeartbeat(voter);
              break;
          }
          const t = fresh.machine.tally();
          if (fresh.machine.state === "APPROVED") {
            const everyoneReachableOrVoted =
              t.approvals >= t.total && fresh.hooks.rejections.length === 0;
            expect(everyoneReachableOrVoted || t.total === 0).toBe(true);
          }
        }
        expect(["IDLE", "VOTING", "STALLED", "REJECTED", "EXPIRED", "APPROVED"]).toContain(
          fresh.machine.state,
        );
      }),
      { numRuns: 30 },
    );
    void req;
  });
});

async function makeVote(
  h: Harness,
  voterPeerIdB64: string,
  requestId: string,
  choice: "APPROVE" | "REJECT",
): Promise<ShredVote> {
  const identity = h.identities.get(voterPeerIdB64)!;
  const vote: ShredVote = {
    type: "SHRED_VOTE",
    requestId,
    roomIdB64: "room",
    epoch: 0,
    voterPeerIdB64,
    voterPubKeyB64: toB64(identity.publicKeyRaw),
    vote: choice,
    rosterHash: await rosterHash(h.roster),
    alg: identity.alg,
    sig: "",
  };
  vote.sig = await signAs(identity, vote);
  return vote;
}

async function signAs(identity: Identity, value: object): Promise<string> {
  const cbor2 = await import("cbor2");
  const { sig, ...rest } = value as { sig?: string } & Record<string, unknown>;
  void sig;
  const bytes = cbor2.encode(rest);
  const { signPayload } = await import("../crypto/identity");
  const signature = await signPayload(identity, bytes);
  return toB64(signature);
}

describe("shred consensus — review fixes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("two-peer unanimous: BOTH sides reach APPROVED (responder counts initiator + own ballot)", async () => {
    const h = await makeHarness(2);
    const keys = [...h.identities.keys()];
    const initiator = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);

    // Responder's machine receives the request…
    const responderHooks = h.hooks;
    void responderHooks;
    const responderMachine = new ShredMachine(
      h.identities.get(keys[1])!,
      keys[1],
      () => h.roster,
      {
        onApproved: () => {},
        onRejected: () => {},
        onExpired: () => {},
        onStalled: () => {},
        onVoteRejectedByGuard: () => {},
      },
    );
    const accepted = await responderMachine.onRequestIncoming(initiator);
    expect(accepted).toBe(true);
    // …and casts its own APPROVE. Its machine must immediately reach
    // APPROVED (initiator implicit + own ballot = 2/2), not stall to EXPIRED.
    const vote = await responderMachine.castMyVote(initiator.requestId, "APPROVE");
    expect(vote).not.toBeNull();
    expect(responderMachine.state).toBe("APPROVED");

    // The initiator's machine approves once the signed vote arrives.
    await h.machine.onVoteIncoming(vote!);
    expect(h.machine.state).toBe("APPROVED");
  });

  it("vote with mismatched rosterHash is blocked (A-08 tripwire)", async () => {
    const h = await makeHarness(2);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    const vote = await makeVote(h, keys[1], req.requestId, "APPROVE");
    const forgedHash = await (async () => {
      const { rosterHash } = await import("./roster");
      return rosterHash([{ peerId: new Uint8Array(16).fill(9), joinedAtSeq: 99 }]);
    })();
    vote.rosterHash = forgedHash;
    vote.sig = await signAs(h.identities.get(keys[1])!, vote);
    await h.machine.onVoteIncoming(vote);
    expect(h.machine.state).toBe("VOTING");
    expect(h.hooks.guardRejects).toContain("roster-mismatch");
  });
});

describe("counted policies — arrival order and early exit (review fix 3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("MAJORITY survives a dissenting vote that arrives first", async () => {
    const h = await makeHarness(5);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "MAJORITY", null, 60_000);

    // REJECT arrives before the approvals
    await h.machine.onVoteIncoming(await makeVote(h, keys[1], req.requestId, "REJECT"));
    expect(h.machine.state).toBe("VOTING");
    await h.machine.onVoteIncoming(await makeVote(h, keys[2], req.requestId, "APPROVE"));
    await h.machine.onVoteIncoming(await makeVote(h, keys[3], req.requestId, "APPROVE"));
    // 3 approvals (initiator + 2) out of 5 = majority reached
    expect(h.machine.state).toBe("APPROVED");
  });

  it("MAJORITY fails once the bar is unreachable without waiting for deadline", async () => {
    const h = await makeHarness(5);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "MAJORITY", null, 60_000);
    // initiator APPROVEs implicitly; 3 REJECTs make bar of 3 unreachable
    // because approvals(1) + undecided(1) < bar(3)
    await h.machine.onVoteIncoming(await makeVote(h, keys[1], req.requestId, "REJECT"));
    await h.machine.onVoteIncoming(await makeVote(h, keys[2], req.requestId, "REJECT"));
    // After 2 rejects: approvals=1, rejections=2, undecided=2; 1+2>=3, still open
    expect(h.machine.state).toBe("VOTING");
    await h.machine.onVoteIncoming(await makeVote(h, keys[3], req.requestId, "REJECT"));
    // After 3 rejects: approvals=1, rejections=3, undecided=1; 1+1<3, unreachable
    expect(h.machine.state).toBe("REJECTED");
    expect(h.hooks.rejections).toEqual([req.requestId]);
  });

  it("THRESHOLD needs a supermajority, not the two peers it used to", async () => {
    // This test previously asserted the opposite: that 2 of 4 was enough.
    // That is minority rule, and one person with two devices is two peers —
    // so the fixed bar was a cheaper version of the INITIATOR policy that was
    // removed for exactly that reason. Four peers now need three.
    const h = await makeHarness(4);
    const keys = [...h.identities.keys()];
    expect(supermajorityFor(4)).toBe(3);
    const req = await h.machine.createRequest("room", 0, "THRESHOLD", supermajorityFor(4), 60_000);

    // Initiator's implicit APPROVE is 1; a second is still short.
    await h.machine.onVoteIncoming(await makeVote(h, keys[1], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("VOTING");

    // The third reaches the bar.
    await h.machine.onVoteIncoming(await makeVote(h, keys[2], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("APPROVED");
  });

  it("a stale low bar in the request cannot lower the local one", async () => {
    // Even if a request carrying THRESHOLD(2) is somehow accepted, evaluate()
    // takes the stricter of the claimed bar and the local supermajority.
    const h = await makeHarness(4);
    const keys = [...h.identities.keys()];
    const req = await h.machine.createRequest("room", 0, "THRESHOLD", 2, 60_000);
    await h.machine.onVoteIncoming(await makeVote(h, keys[1], req.requestId, "APPROVE"));
    expect(h.machine.state).toBe("VOTING");
  });
});

describe("machine hardening", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /// A machine belonging to the second peer, sharing the harness roster.
  function responderFor(h: Harness): ShredMachine {
    const key = [...h.identities.keys()][1];
    return new ShredMachine(h.identities.get(key)!, key, () => h.roster, h.hooks);
  }

  it("accepts a fresh request after a settled one", async () => {
    const h = await makeHarness(2);
    const responder = responderFor(h);

    const first = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    expect(await responder.onRequestIncoming(first)).toBe(true);
    await responder.castMyVote(first.requestId, "REJECT");
    expect(responder.state).toBe("REJECTED");

    // Previously this returned false with "busy" forever: nothing resets the
    // machine after a settled vote, so the room could never shred again.
    const second = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);
    expect(await responder.onRequestIncoming(second)).toBe(true);
    expect(responder.state).toBe("VOTING");
  });

  it("refuses a malformed request without changing state", async () => {
    const h = await makeHarness(2);
    const responder = responderFor(h);
    const req = await h.machine.createRequest("room", 0, "UNANIMOUS", null, 60_000);

    for (const bad of [
      { ...req, requestId: "" },
      { ...req, requestId: "x".repeat(200) },
      { ...req, policy: "WHATEVER" as never },
      { ...req, deadlineMs: Number.NaN },
      { ...req, deadlineMs: -1 },
      { ...req, deadlineMs: 7_200_000 },
    ]) {
      expect(await responder.onRequestIncoming(bad)).toBe(false);
      expect(responder.state).toBe("IDLE");
    }
    expect(h.hooks.guardRejects).toContain("malformed-request");
  });
});

describe("cancelling a shred request", () => {
  const current = { requestId: "req-1", initiatorPeerIdB64: "alice" };

  it("is honoured from the peer who made it, for that request", () => {
    expect(cancelApplies(current, { requestId: "req-1" }, "alice")).toBe(true);
  });

  it("is ignored from anyone else, so an outvoted member cannot end a MAJORITY vote", () => {
    expect(cancelApplies(current, { requestId: "req-1" }, "mallory")).toBe(false);
  });

  it("is ignored for another request, or with no request open", () => {
    expect(cancelApplies(current, { requestId: "req-0" }, "alice")).toBe(false);
    expect(cancelApplies(current, {}, "alice")).toBe(false);
    expect(cancelApplies(null, { requestId: "req-1" }, "alice")).toBe(false);
  });
});
