import * as cbor2 from "cbor2";
import { signPayload, verifyPayload, type Identity, type SignatureAlg } from "../crypto/identity";
import { rosterHash, type RosterEntry } from "./roster";

/// INITIATOR was removed deliberately: it let one participant destroy work
/// everyone else was still doing. THRESHOLD survives only because it now
/// scales with the room — as a fixed "any 2 peers" it was the same hazard
/// wearing the costume of consensus, and cheaper to reach, since one person
/// with two devices is two peers.
export type Policy = "UNANIMOUS" | "MAJORITY" | "THRESHOLD";

export const POLICIES: readonly Policy[] = ["UNANIMOUS", "MAJORITY", "THRESHOLD"];

/// Two-thirds, never fewer than two. Sits between MAJORITY and UNANIMOUS:
/// stricter than half, but does not hand a veto to one absent person.
export function supermajorityFor(peerCount: number): number {
  return Math.max(2, Math.ceil((peerCount * 2) / 3));
}

export interface ShredRequest {
  type: "SHRED_REQUEST";
  requestId: string;
  roomIdB64: string;
  epoch: number;
  policy: Policy;
  threshold: number | null;
  rosterHash: string;
  initiatorPeerIdB64: string;
  initiatorPubKeyB64: string;
  alg: SignatureAlg;
  issuedAt: number;
  deadlineMs: number;
  sig: string;
}

export interface ShredVote {
  type: "SHRED_VOTE";
  requestId: string;
  roomIdB64: string;
  epoch: number;
  voterPeerIdB64: string;
  voterPubKeyB64: string;
  vote: "APPROVE" | "REJECT";
  rosterHash: string;
  alg: SignatureAlg;
  sig: string;
}

export type MachineState =
  | "IDLE"
  | "VOTING"
  | "STALLED"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "PURGING"
  | "GONE";

const encoder = new TextEncoder();

function canonicalBytes(value: Record<string, unknown>): Uint8Array {
  return cbor2.encode(value);
}

async function signObject(identity: Identity, value: Record<string, unknown>): Promise<string> {
  const { sig, ...rest } = value;
  void sig;
  const bytes = canonicalBytes(rest);
  const signature = await signPayload(identity, bytes);
  let s = "";
  for (const b of signature) s += String.fromCharCode(b);
  return btoa(s);
}

async function verifyObject(
  value: Record<string, unknown>,
  pubkeyRaw: Uint8Array,
): Promise<boolean> {
  const { sig, ...rest } = value;
  if (typeof sig !== "string") return false;
  const signature = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
  return verifyPayload(rest.alg as SignatureAlg, pubkeyRaw, signature, canonicalBytes(rest));
}

export function randomRequestId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export interface MachineHooks {
  onRosterMismatch?(requestId?: string): void;
  onApproved(requestId: string): void;
  onRejected(requestId: string): void;
  onExpired(requestId: string): void;
  onStalled(requestId: string, waitingOn: string[]): void;
  onVoteRejectedByGuard(reason: string): void;
}

interface FrozenRequest extends ShredRequest {
  frozenRoster: RosterEntry[];
}

export class ShredMachine {
  state: MachineState = "IDLE";
  private frozen: FrozenRequest | null = null;
  private votes = new Map<string, "APPROVE" | "REJECT">();
  private unreachable = new Set<string>();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  setMyPeerId(peerIdB64: string): void {
    this.myPeerIdB64 = peerIdB64;
  }

  currentRequest(): ShredRequest | null {
    return this.frozen ? { ...this.frozen } : null;
  }

  constructor(
    private identity: Identity,
    private myPeerIdB64: string,
    private rosterProvider: () => RosterEntry[],
    private hooks: MachineHooks,
  ) {}

  reset(): void {
    this.state = "IDLE";
    this.frozen = null;
    this.votes.clear();
    this.unreachable.clear();
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  async createRequest(
    roomIdB64: string,
    epoch: number,
    policy: Policy,
    threshold: number | null,
    deadlineMs: number,
  ): Promise<ShredRequest> {
    this.reset();
    const roster = this.rosterProvider();
    const hash = await rosterHash(roster);
    const request: ShredRequest = {
      type: "SHRED_REQUEST",
      requestId: randomRequestId(),
      roomIdB64,
      epoch,
      policy,
      threshold,
      rosterHash: hash,
      initiatorPeerIdB64: this.myPeerIdB64,
      initiatorPubKeyB64: toB64(this.identity.publicKeyRaw),
      alg: this.identity.alg,
      issuedAt: Date.now(),
      deadlineMs,
      sig: "",
    };
    request.sig = await signObject(this.identity, { ...request });
    this.frozen = { ...request, frozenRoster: roster };
    this.state = "VOTING";
    this.votes.set(this.myPeerIdB64, "APPROVE");
    this.armDeadline(deadlineMs);
    this.evaluate();
    return request;
  }

  async castMyVote(requestId: string, choice: "APPROVE" | "REJECT"): Promise<ShredVote | null> {
    if (!this.frozen || this.frozen.requestId !== requestId) return null;
    const rosterEntry = this.frozen.frozenRoster.find((r) => toB64(r.peerId) === this.myPeerIdB64);
    if (!rosterEntry?.pubkey || !this.identity.keypair.privateKey) {
      return null;
    }
    const vote: ShredVote = {
      type: "SHRED_VOTE",
      requestId,
      roomIdB64: this.frozen.roomIdB64,
      epoch: this.frozen.epoch,
      voterPeerIdB64: this.myPeerIdB64,
      voterPubKeyB64: toB64(this.identity.publicKeyRaw),
      vote: choice,
      rosterHash: this.frozen.rosterHash,
      alg: this.identity.alg,
      sig: "",
    };
    vote.sig = await signObject(this.identity, { ...vote });
    // The voter's own machine must count its own ballot immediately,
    // otherwise a two-peer unanimous request approves on one side while
    // stalling on the other.
    this.votes.set(this.myPeerIdB64, choice);
    this.evaluate();
    return vote;
  }

  async onRequestIncoming(request: ShredRequest): Promise<boolean> {
    // A settled vote is not a vote in progress. Refusing every later request
    // until something calls reset() left the room unable to shred at all
    // after one rejection or timeout.
    if (this.state === "REJECTED" || this.state === "EXPIRED") {
      this.reset();
    }
    if (this.state !== "IDLE") {
      this.hooks.onVoteRejectedByGuard("busy");
      return false;
    }
    if (
      typeof request.requestId !== "string" ||
      !request.requestId ||
      request.requestId.length > 128 ||
      !POLICIES.includes(request.policy) ||
      typeof request.deadlineMs !== "number" ||
      !Number.isFinite(request.deadlineMs) ||
      request.deadlineMs < 0 ||
      request.deadlineMs > 3_600_000
    ) {
      this.hooks.onVoteRejectedByGuard("malformed-request");
      return false;
    }
    // Refuse a policy this build no longer offers. An older or hostile peer
    // can still put INITIATOR on the wire; nobody has to honour it.
    if (!POLICIES.includes(request.policy)) {
      this.hooks.onVoteRejectedByGuard("policy-not-permitted");
      return false;
    }
    // The bar travels inside the signed request, so a hostile initiator could
    // otherwise claim THRESHOLD(1) and shred alone. Each receiver checks the
    // claim against its own roster rather than trusting the number.
    if (request.policy === "THRESHOLD") {
      const required = supermajorityFor(this.rosterProvider().length);
      if (typeof request.threshold !== "number" || request.threshold < required) {
        this.hooks.onVoteRejectedByGuard("threshold-below-supermajority");
        return false;
      }
    }
    const roster = this.rosterProvider();
    const localHash = await rosterHash(roster);
    if (localHash !== request.rosterHash) {
      this.hooks.onVoteRejectedByGuard("roster-mismatch");
      return false;
    }
    const initiator = roster.find((r) => toB64(r.peerId) === request.initiatorPeerIdB64);
    if (!initiator?.pubkey) {
      this.hooks.onVoteRejectedByGuard("unknown-initiator");
      return false;
    }
    const ok = await verifyObject({ ...request }, initiator.pubkey);
    if (!ok) {
      this.hooks.onVoteRejectedByGuard("bad-signature");
      return false;
    }
    this.frozen = { ...request, frozenRoster: roster };
    this.state = "VOTING";
    // The initiator's approval is implicit in signing the request.
    this.votes.set(request.initiatorPeerIdB64, "APPROVE");
    this.armDeadline(request.deadlineMs);
    this.evaluate();
    return true;
  }

  async onVoteIncoming(rawVote: ShredVote): Promise<void> {
    const vote: ShredVote = rawVote;
    if (!this.frozen || vote.requestId !== this.frozen.requestId) {
      this.hooks.onVoteRejectedByGuard("unknown-request");
      return;
    }
    if (this.state !== "VOTING" && this.state !== "STALLED") {
      this.hooks.onVoteRejectedByGuard(`state-${this.state}`);
      return;
    }
    const voterKey = vote.voterPeerIdB64 as string;
    if (this.votes.has(voterKey)) {
      this.hooks.onVoteRejectedByGuard("duplicate-vote");
      return;
    }
    if (vote.rosterHash !== this.frozen.rosterHash) {
      // A-08 tripwire: a relay hiding peers shifts one client's roster hash.
      // Block the vote and surface it loudly.
      this.hooks.onRosterMismatch?.();
      this.hooks.onVoteRejectedByGuard("roster-mismatch");
      return;
    }
    const rosterEntry = this.frozen.frozenRoster.find((r) => toB64(r.peerId) === voterKey);
    if (!rosterEntry?.pubkey) {
      this.hooks.onVoteRejectedByGuard("unknown-voter");
      return;
    }
    if ((vote.voterPubKeyB64 as string) !== toB64(rosterEntry.pubkey)) {
      this.hooks.onVoteRejectedByGuard("voter-key-mismatch");
      return;
    }
    const ok = await verifyObject({ ...vote }, rosterEntry.pubkey);
    if (!ok) {
      this.hooks.onVoteRejectedByGuard("bad-signature");
      return;
    }
    this.unreachable.delete(voterKey);
    this.votes.set(voterKey, vote.vote);
    this.evaluate();
  }

  noteHeartbeat(peerIdB64: string): void {
    this.unreachable.delete(peerIdB64);
    this.evaluate();
  }

  markUnreachable(peerIdB64: string): void {
    if (this.frozen && this.frozen.frozenRoster.some((r) => toB64(r.peerId) === peerIdB64)) {
      this.unreachable.add(peerIdB64);
      this.evaluate();
    }
  }

  private armDeadline(deadlineMs: number): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => {
      if (this.state === "VOTING" || this.state === "STALLED") {
        this.state = "EXPIRED";
        this.hooks.onExpired(this.frozen!.requestId);
      }
    }, Math.max(0, deadlineMs));
  }

  tally(): { approvals: number; rejections: number; total: number; reachableTotal: number } {
    let approvals = 0;
    let rejections = 0;
    for (const v of this.votes.values()) {
      if (v === "APPROVE") approvals += 1;
      else rejections += 1;
    }
    const total = this.frozen?.frozenRoster.length ?? 0;
    const reachableTotal = total - this.unreachable.size;
    return { approvals, rejections, total, reachableTotal };
  }

  waitingOn(): string[] {
    if (!this.frozen) return [];
    return this.frozen.frozenRoster
      .map((r) => toB64(r.peerId))
      .filter((id) => !this.votes.has(id) && !this.unreachable.has(id));
  }

  private evaluate(): void {
    if (!this.frozen) return;
    const req = this.frozen;
    const { approvals, rejections, total } = this.tally();
    const undecided = Math.max(0, total - approvals - rejections);

    // Spec §5.6 rule 8: under UNANIMOUS a single REJECT makes the outcome
    // impossible, so do not wait out the clock.
    if (req.policy === "UNANIMOUS" && rejections > 0) {
      this.state = "REJECTED";
      this.clearDeadline();
      this.hooks.onRejected(req.requestId);
      return;
    }

    // Everyone approved: satisfies every policy.
    if (total > 0 && approvals >= total) {
      this.state = "APPROVED";
      this.clearDeadline();
      this.hooks.onApproved(req.requestId);
      return;
    }

    switch (req.policy) {
      case "UNANIMOUS": {
        if (this.unreachable.size > 0) {
          this.state = "STALLED";
          this.hooks.onStalled(req.requestId, [...this.unreachable]);
        } else {
          this.state = "VOTING";
          this.hooks.onStalled(req.requestId, []);
        }
        return;
      }
      case "MAJORITY": {
        const bar = Math.floor(total / 2) + 1;
        this.settleCounted(req, approvals, undecided, bar);
        return;
      }
      case "THRESHOLD": {
        // Never trust the number in the request over the local roster.
        const bar = Math.max(
          req.threshold ?? Number.MAX_SAFE_INTEGER,
          supermajorityFor(total),
        );
        this.settleCounted(req, approvals, undecided, bar);
        return;
      }
    }
  }

  /// Counted policies approve once the bar is met and fail once it can no
  /// longer be reached, even if votes are still outstanding. Anything in
  /// between stays open until the deadline, which fails closed.
  private settleCounted(
    req: FrozenRequest,
    approvals: number,
    undecided: number,
    bar: number,
  ): void {
    if (approvals >= bar) {
      this.state = "APPROVED";
      this.clearDeadline();
      this.hooks.onApproved(req.requestId);
    } else if (approvals + undecided < bar) {
      this.state = "REJECTED";
      this.clearDeadline();
      this.hooks.onRejected(req.requestId);
    }
  }

  beginPurge(): void {
    this.state = "PURGING";
    this.clearDeadline();
  }

  finishPurge(): void {
    this.state = "GONE";
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}

export { encoder };
