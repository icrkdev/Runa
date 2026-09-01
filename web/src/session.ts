import * as cbor2 from "cbor2";
import { RunaSocket, fromB64, type JoinAck } from "./transport/socket";
import { FT } from "./transport/frame";
import { RunaDoc, wrapWithLengthAndPad } from "./doc/ydoc";
import { bindMonaco, type Binding } from "./doc/binding";
import { AwarenessHub } from "./doc/awareness";
import { generateIdentity, type Identity } from "./crypto/identity";
import {
  ShredMachine,
  type Policy,
  type ShredRequest,
} from "./shred/machine";
import type { RosterEntry } from "./shred/roster";
import { executeWipe } from "./shred/wipe";

export type LadderPhase =
  | { kind: "none" }
  | { kind: "normal"; remainingMs: number }
  | { kind: "watch"; remainingMs: number }
  | { kind: "armed"; remainingMs: number }
  | { kind: "burn"; remainingMs: number };

type ExpiryModel =
  | { kind: "none" }
  | { kind: "absolute"; deadlinePerfMs: number }
  | { kind: "idle"; windowMs: number; lastActivityPerfMs: number };

export interface SessionEvents {
  onJoinAck(ack: JoinAck): void;
  onPeersChanged(count: number): void;
  onTemper(temper: "COLD" | "SECURE" | "WATCH" | "ARMED" | "BURN"): void;
  onShredPrompt(request: ShredRequest): void;
  onShredState(state: string, waitingOnPeerId?: string): void;
  onPurge(reason: string): void;
  onCountdown(phase: LadderPhase): void;
  onTtlMismatch(): void;
  onDivergence(): void;
}

export interface SessionConfig {
  url: string;
  roomIdHex: string;
  authKey: Uint8Array;
  contentKey: CryptoKey;
  insecureAllowed?: boolean;
}

interface SocketInternals {
  ws?: WebSocket;
  roster: Map<string, RosterEntry>;
  myPeerId: string;
  myJoinedSeq: number;
  joinPerfMs: number;
}

export class Session {
  readonly doc: RunaDoc;
  readonly socket: RunaSocket;
  readonly identity: Identity;
  awareness: AwarenessHub | null = null;

  private binding: Binding | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private machine: ShredMachine;
  private internals: SocketInternals;
  private destroyed = false;
  wipeContext: WipeContext = {};
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private steadyTimer: ReturnType<typeof setInterval> | null = null;
  private ownHash = "";

  private constructor(
    private cfg: SessionConfig,
    identity: Identity,
    doc: RunaDoc,
    socket: RunaSocket,
    machine: ShredMachine,
    internals: SocketInternals,
    private events: SessionEvents,
  ) {
    this.identity = identity;
    this.doc = doc;
    this.socket = socket;
    this.machine = machine;
    this.internals = internals;
  }

  static async create(cfg: SessionConfig, events: SessionEvents): Promise<Session> {
    const identity = await generateIdentity();
    const roomId = hexToBytes(cfg.roomIdHex);
    const roster = new Map<string, RosterEntry>();
    const internals: SocketInternals = { roster, myPeerId: "", myJoinedSeq: 0, joinPerfMs: 0 };
    let sessionRef: Session | null = null;

    const socket = new RunaSocket({
      url: cfg.url,
      roomId,
      authKey: cfg.authKey,
      identity,
      contentKey: cfg.contentKey,
      insecureAllowed: cfg.insecureAllowed,
      events: {
        onJoinAck: (ack) => sessionRef?.handleJoinAck(ack),
        onDocUpdate: (sender, envelope) =>
          sessionRef?.handleRemoteUpdate(envelope) ?? void sender,
        onSnapshot: (sender, covers, blob) => sessionRef?.handleSnapshot(sender, covers, blob),
        onAwareness: (sender, pt) => sessionRef?.awareness?.receive(sender, pt),
        onShredFrame: (ft, sender, pt) => void sessionRef?.handleShredFrame(ft, sender, pt),
        onPeerJoin: (entry) => {
          roster.set(toB64(entry.peerId), entry);
          events.onPeersChanged(roster.size);
        },

        onPeerLeave: (peerId) => {
          roster.delete(toB64(peerId));
          events.onPeersChanged(roster.size);
        },
        onPurge: (reason) => events.onPurge(reason),
        onTtlExtended: (remaining, effective, addedBy) =>
          sessionRef?.handleTtlExtended(remaining, effective, addedBy),
        onError: () => events.onTemper("WATCH"),
        onEpochStale: () => events.onTemper("WATCH"),
        onDisconnected: () => events.onTemper("COLD"),
      },
    });

    const doc = new RunaDoc({
      transport: {
        sendUpdate: async (wrapped) => {
          sessionRef?.refreshActivity();
          await socket.sendUpdate(wrapped);
        },
        sendSnapshot: async (state, covers) => socket.sendSnapshot(state, covers),
        sendSyncRequest: (fromIndex) => socket.sendSyncRequest(fromIndex),
      },
    });

    const machine = new ShredMachine(identity, "", () => [...roster.values()], {
      onApproved: () => void sessionRef?.purgeNow(),
      onRejected: () => events.onShredState("REJECTED"),
      onExpired: () => events.onShredState("EXPIRED"),
      onStalled: (_id, waiting) =>
        events.onShredState(waiting.length ? "STALLED" : "VOTING", waiting[0]),
      onVoteRejectedByGuard: () => {},
    });

    const session = new Session(cfg, identity, doc, socket, machine, internals, events);
    sessionRef = session;
    void socket.connect().catch(() => {
      events.onTemper("COLD");
    });
    return session;
  }

  private async handleJoinAck(ack: JoinAck): Promise<void> {
    this.internals.myPeerId = ack.peer_id;
    this.internals.myJoinedSeq = ack.roster.find((r) => r.peer_id === ack.peer_id)?.joined_at_seq ?? 0;
    this.internals.joinPerfMs = performance.now();
    this.machine.setMyPeerId(ack.peer_id);
    for (const r of ack.roster) {
      this.internals.roster.set(r.peer_id, {
        peerId: fromB64(r.peer_id),
        pubkey: r.pubkey ? fromB64(r.pubkey) : undefined,
        joinedAtSeq: r.joined_at_seq,
      });
    }

    // The AEAD-protected room config is authoritative over the cleartext
    // TTL the server reports (spec §5.9.3). A server that omits or garbles
    // the blob falls back to its clear value; a server that contradicts it
    // gets the mismatch banner AND loses the dispute.
    let effectiveTtl = ack.ttl;
    if (ack.config_blob) {
      const cfgTtl = await this.decryptConfigBlob(ack.config_blob);
      if (cfgTtl) {
        const kindMismatch =
          cfgTtl.kind === "none" ? ack.ttl.kind !== "none" : cfgTtl.kind !== ack.ttl.kind;
        const shortenedAbsolute =
          cfgTtl.kind === "absolute" &&
          ack.ttl.kind === "absolute" &&
          ack.ttl.secs < cfgTtl.secs - 1;
        if (kindMismatch || shortenedAbsolute) {
          this.events.onTtlMismatch();
          effectiveTtl =
            cfgTtl.kind === "none"
              ? { kind: "none", secs: 0 }
              : { kind: cfgTtl.kind as typeof ack.ttl.kind, secs: cfgTtl.secs };
        }
      } else {
        this.events.onTtlMismatch();
      }
    }

    switch (effectiveTtl.kind) {
      case "none":
        this.armExpiryClock({ kind: "none" });
        break;
      case "absolute":
        this.armExpiryClock({
          kind: "absolute",
          deadlinePerfMs: performance.now() + effectiveTtl.secs * 1000,
        });
        break;
      default:
        this.armExpiryClock({
          kind: "idle",
          windowMs: effectiveTtl.secs * 1000,
          lastActivityPerfMs: performance.now(),
        });
        break;
    }

    this.events.onPeersChanged(this.internals.roster.size);
    this.events.onTemper("SECURE");
    this.events.onJoinAck(ack);
    // Resume rather than replay: asking from 0 on every reconnect pulls the
    // entire room log down again each time.
    this.socket.sendSyncRequest(this.doc.syncFrom());
  }

  private async decryptConfigBlob(
    blobB64: string,
  ): Promise<{ kind: string; secs: number } | null> {
    try {
      const blob = fromB64(blobB64);
      const iv = blob.slice(0, 12);
      const ct = blob.slice(12);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        this.cfg.contentKey,
        ct,
      );
      const parsed = JSON.parse(new TextDecoder().decode(pt)) as {
        ttl: { kind: string; secs: number };
      };
      return parsed.ttl;
    } catch {
      return null;
    }
  }

  private expiry: ExpiryModel = { kind: "none" };
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private wiped = false;

  /// Absolute TTL anchors at join against the AEAD-protected config value
  /// when present. Idle TTL is an activity-driven window — any local edit,
  /// remote update or peer change refreshes it, so a tab never
  /// self-destructs mid-session while the server still considers the room
  /// alive.
  private visibilityHandler: (() => void) | null = null;

  private armExpiryClock(model: ExpiryModel): void {
    this.expiry = model;
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    // Re-armed on every JOIN_ACK, so every reconnect used to add another
    // listener that was never removed.
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (model.kind === "none") return;
    this.expiryTimer = setInterval(() => this.tickExpiry(), 250);
    this.visibilityHandler = () => this.tickExpiry();
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.tickExpiry();
  }

  refreshActivity(): void {
    if (this.expiry.kind === "idle") {
      this.expiry.lastActivityPerfMs = performance.now();
    }
  }

  private tickExpiry(): void {
    if (this.wiped) return;
    let remaining: number;
    switch (this.expiry.kind) {
      case "none":
        return;
      case "absolute":
        remaining = this.expiry.deadlinePerfMs - performance.now();
        break;
      case "idle":
        remaining =
          this.expiry.lastActivityPerfMs + this.expiry.windowMs - performance.now();
        break;
    }
    if (remaining <= 0) {
      this.wiped = true;
      if (this.expiryTimer) clearInterval(this.expiryTimer);
      void this.purgeNow();
      return;
    }
    if (remaining <= 10_000) {
      this.events.onCountdown({ kind: "burn", remainingMs: remaining });
    } else if (remaining <= 60_000) {
      this.events.onCountdown({ kind: "armed", remainingMs: remaining });
    } else if (remaining <= 5 * 60_000) {
      this.events.onCountdown({ kind: "watch", remainingMs: remaining });
    } else {
      this.events.onCountdown({ kind: "normal", remainingMs: remaining });
    }
  }

  /// `remainingSecs` is what the server says is left, not what we asked for.
  /// The server clamps extensions at a ceiling, so adding our own request to
  /// the local clock would drift past the real deadline — and the extender
  /// used to count its own request twice, once locally and once from the
  /// broadcast it also receives.
  handleTtlExtended(remainingSecs: number, addSecs: number, addedBy: string): void {
    if (this.expiry.kind === "absolute" && remainingSecs > 0) {
      this.expiry.deadlinePerfMs = performance.now() + remainingSecs * 1000;
    } else if (this.expiry.kind === "idle") {
      if (remainingSecs > 0) this.expiry.windowMs = remainingSecs * 1000;
      this.refreshActivity();
    }
    this.wiped = false;
    this.events.onShredState(`EXTENDED +${Math.round(addSecs / 60)}m by ${addedBy.slice(0, 6)}…`);
  }

  extendExpiry(addSecs = 1800): void {
    // Fire and wait: the server echoes the authoritative deadline back to
    // every peer, this one included.
    this.socket.sendTtlExtend(addSecs);
  }

  tallySummary(): { approved: number; total: number; waitingOn?: string } {
    const t = this.machine.tally();
    const waiting = this.machine.waitingOn()[0];
    return { approved: t.approvals, total: t.total, waitingOn: waiting };
  }

  private handleRemoteUpdate(envelope: Uint8Array): void {
    if (envelope.length < 4) return;
    const len = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength)
      .getUint32(0, false);
    if (len === 0) return;
    // A peer holding the room key can still send a malformed CRDT update.
    // These handlers run from an unawaited promise, so a throw here becomes
    // an unhandled rejection and silently stops the rest of the pipeline.
    try {
      this.doc.applyRemote(envelope);
    } catch {
      return;
    }
    this.refreshActivity();
    void this.refreshOwnHash();
  }

  private handleSnapshot(_sender: Uint8Array, _covers: bigint, blobWithPrefix: Uint8Array): void {
    try {
      this.doc.applyRemote(blobWithPrefix);
    } catch {
      return;
    }
    void this.refreshOwnHash();
  }

  /// Deterministic snapshot election (spec §5.8): the peer with the lowest
  /// (joined_at_seq, peer_id) snapshots when thresholds fire.
  private startSnapshotLoop(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => {
      if (performance.now() - this.internals.joinPerfMs < 60_000) return;
      const roster = [...this.internals.roster.values()];
      if (!roster.length) return;
      const me = toB64(hexToBytes(this.cfg.roomIdHex)) && this.internals.myPeerId;
      const elected = [...roster].sort((a, b) =>
        a.joinedAtSeq !== b.joinedAtSeq
          ? a.joinedAtSeq - b.joinedAtSeq
          : cmpBytes(a.peerId, b.peerId),
      )[0];
      if (toB64(elected.peerId) !== me) return;
      const estimate = BigInt(this.doc.baseIndex + this.doc.updateCount);
      if (this.doc.shouldSnapshot(BigInt(Math.max(Number(estimate), 1)))) {
        void this.doc.createSnapshot(estimate);
      }
    }, 30_000);
  }

  setSteadyTraffic(on: boolean, intervalMs = 400): void {
    if (this.steadyTimer) {
      clearInterval(this.steadyTimer);
      this.steadyTimer = null;
    }
    if (!on) return;
    this.steadyTimer = setInterval(() => {
      // Cover traffic goes out as AWARENESS, not DOC_UPDATE. The server
      // appends every DOC_UPDATE to the room log and cannot tell padded cover
      // frames from padded real edits — that is the point of the padding — so
      // sending it as an update quietly ate the room's log budget until real
      // edits started being refused. AWARENESS is relayed and never stored.
      void this.socket.sendAwareness(wrapWithLengthAndPad(new Uint8Array(0)));
    }, intervalMs);
  }

  private hashPending = false;

  private async refreshOwnHash(): Promise<void> {
    // Digesting the whole document on every remote update is O(doc) per
    // keystroke. One in flight at a time is enough for a divergence check.
    if (this.hashPending) return;
    this.hashPending = true;
    try {
      await this.computeOwnHash();
    } finally {
      this.hashPending = false;
    }
  }

  private async computeOwnHash(): Promise<void> {
    const text = this.doc.value;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text) as BufferSource,
    );
    this.ownHash = Array.from(new Uint8Array(digest).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const hashes = this.awareness?.foreignHashes();
    if (hashes && hashes.size > 0 && !hashes.has(this.ownHash)) {
      this.events.onDivergence();
    }
  }

  ownDocumentHash(): string {
    return this.ownHash;
  }

  private async handleShredFrame(frameType: number, sender: Uint8Array, plaintext: Uint8Array): Promise<void> {
    let decoded: Record<string, unknown>;
    try {
      decoded = cbor2.decode(plaintext) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!decoded || typeof decoded !== "object") return;
    if (frameType === FT.SHRED_REQUEST) {
      const request = decoded as unknown as ShredRequest;
      if (request.initiatorPeerIdB64 === this.internals.myPeerId) return;
      const accepted = await this.machine.onRequestIncoming(request);
      if (accepted) this.events.onShredPrompt(request);
      return;
    }
    if (frameType === FT.SHRED_VOTE) {
      await this.machine.onVoteIncoming(decoded as never);
      return;
    }
    if (frameType === FT.SHRED_CANCEL) {
      this.machine.reset();
      this.events.onShredState("IDLE");
    }
    void sender;
  }

  async attachEditor(
    monaco: typeof import("monaco-editor"),
    editor: import("monaco-editor").editor.IStandaloneCodeEditor,
  ): Promise<void> {
    const model = editor.getModel();
    if (!model) return;
    const seeded = this.doc.value;
    if (seeded && model.getValue() !== seeded) {
      model.setValue(seeded);
    }
    this.binding = bindMonaco(monaco, model, this.doc.ydoc, this.doc.text);
    this.awareness = await AwarenessHub.create(
      (pt) => this.socket.sendAwareness(pt),
      this.identity.publicKeyRaw,
    );
    // Heartbeat is an awareness ping (not a sync request): it drives peer
    // liveness detection and divergence comparison without re-requesting
    // the entire log every 10 seconds (review R-3/R-7/R-8).
    const lastLine = 1;
    const lastCol = 1;
    this.heartbeatTimer = setInterval(() => {
      void this.awareness?.broadcastCursor(lastLine, lastCol, this.ownDocumentHash());
      const seen = new Set(
        (this.awareness?.snapshot() ?? []).map((s) => s.senderId),
      );
      const machine = this.machine;
      for (const peerIdB64 of this.internals.roster.keys()) {
        if (peerIdB64 === this.internals.myPeerId) continue;
        if (seen.has(peerIdB64)) machine.noteHeartbeat(peerIdB64);
        else machine.markUnreachable(peerIdB64);
      }
    }, 10_000);

    this.startSnapshotLoop();
    editor.onDidChangeCursorPosition((e) => {
      void this.awareness?.broadcastCursor(
        e.position.lineNumber,
        e.position.column,
        this.ownDocumentHash(),
      );
    });
  }

  setWipeContext(ctx: WipeContext): void {
    this.wipeContext = ctx;
  }

  setInsecure(insecure: boolean): void {
    if (insecure) this.events.onTemper("WATCH");
  }

  dropKeys(): void {
    // CryptoKey references are dropped so the runtime can reclaim the last
    // handles; non-extractable keys cannot be serialised out of the tab.
    // The socket and its cipher hold their own references, so clearing only
    // the session's copy left the key reachable for the tab's lifetime.
    (this as unknown as { cfg: { contentKey: CryptoKey | null } }).cfg.contentKey = null;
    this.socket.dropKeys();
    this.awareness?.dispose();
    this.awareness = null;
  }

  get peerCount(): number {
    return this.internals.roster.size;
  }

  async requestShred(policy: Policy, threshold: number | null, deadlineMs = 60_000): Promise<void> {
    const roomB64 = toB64(hexToBytes(this.cfg.roomIdHex));
    const request = await this.machine.createRequest(roomB64, 0, policy, threshold, deadlineMs);
    await this.socket.sendShredFrame(FT.SHRED_REQUEST, cbor2.encode({ ...request }));
  }

  async respondToShred(request: ShredRequest, choice: "APPROVE" | "REJECT"): Promise<void> {
    const vote = await this.machine.castMyVote(request.requestId, choice);
    if (!vote) return;
    await this.socket.sendShredFrame(FT.SHRED_VOTE, cbor2.encode({ ...vote }));
  }

  cancelShred(): void {
    const current = this.machine.currentRequest();
    if (current) {
      void this.socket.sendShredFrame(
        FT.SHRED_CANCEL,
        cbor2.encode({ type: "SHRED_CANCEL", requestId: current.requestId }),
      );
    }
    this.machine.reset();
    this.events.onShredState("IDLE");
  }

  async purgeNow(): Promise<void> {
    this.machine.beginPurge();
    try {
      this.socket.sendPurgeAck("consensus");
    } catch {
      void 0;
    }
    await executeWipe(browserHost(this));
  }

  destroySession(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.steadyTimer) clearInterval(this.steadyTimer);
    this.binding?.dispose();
    this.doc.destroy();
    this.socket.close();
  }
}

interface WipeContext {
  editor?: import("monaco-editor").editor.IStandaloneCodeEditor | null;
  model?: import("monaco-editor").editor.ITextModel | null;
  previewEl?: HTMLElement | null;
}

export function browserHost(session: Session): import("./shred/wipe").WipeHost {
  const ctx: WipeContext = session.wipeContext ?? {};
  let keyboardBlocked = false;

  return {
    editorDetach() {
      try {
        ctx.editor?.updateOptions({ readOnly: true });
        ctx.model?.pushEOL("LF" as never);
      } catch {
        void 0;
      }
    },
    blockKeyboard() {
      if (keyboardBlocked) return;
      keyboardBlocked = true;
      document.addEventListener(
        "keydown",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
        },
        { capture: true },
      );
      document.addEventListener(
        "beforeinput",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
        },
        { capture: true },
      );
    },
    cancelNetwork() {
      try {
        session.socket.close();
      } catch {
        void 0;
      }
    },
    ydocDestroy() {
      session.destroySession();
    },
    modelDispose() {
      try {
        ctx.model?.dispose();
      } catch {
        void 0;
      }
    },
    editorDispose() {
      try {
        ctx.editor?.dispose();
      } catch {
        void 0;
      }
    },
    previewRootReplaceChildren() {
      ctx.previewEl?.replaceChildren();
    },
    dropKeys() {
      session.dropKeys();
    },
    socketClose() {
      try {
        session.socket.close();
      } catch {
        void 0;
      }
    },
    async clearCaches() {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      try {
        // The wipe sequence is the one legitimate use of storage clearing:
        // it removes anything a prior bug might have leaked (spec §7.8 step 7).
        // eslint-disable-next-line no-restricted-globals
        sessionStorage.clear();
        // eslint-disable-next-line no-restricted-globals
        localStorage?.clear?.();
      } catch {
        void 0;
      }
      const idb = (window as unknown as { indexedDB?: { databases(): Promise<unknown[]>; deleteDatabase(n: string): void } }).indexedDB;
      if (idb && typeof idb.databases === "function") {
        const dbs = (await idb.databases()) as { name?: string }[];
        for (const db of dbs) {
          if (db.name) idb.deleteDatabase(db.name);
        }
      }
    },
    async unregisterServiceWorkers() {
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      await Promise.all(regs.map((r) => r.unregister()));
    },
    navigate(href: string) {
      window.location.replace(href);
    },
  };
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
