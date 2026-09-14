import { FrameCipher, decryptEnvelope } from "../crypto/aead";
import type { Identity } from "../crypto/identity";
import {
  concatBytes,
  encodeHeader,
  FT,
  HEADER_LEN,
  PROTOCOL_VERSION,
  buildFrame,
  buildJsonFrame,
  parseFrame,
  stripEnvelope,
  type EnvelopedFrame,
  type FrameHeader,
} from "./frame";

export interface RosterEntry {
  peerId: Uint8Array;
  pubkey?: Uint8Array;
  joinedAtSeq: number;
}

export interface JoinAck {
  peer_id: string;
  epoch: number;
  log_len: number;
  base_index: number;
  has_snapshot: boolean;
  ttl: { kind: string; secs: number };
  /// How long the room has been alive. For an absolute TTL `ttl.secs` is the
  /// time remaining, so this is what makes the original duration recoverable.
  /// Optional because a server that predates it simply will not send one.
  elapsed_secs?: number;
  ceiling_optout: boolean;
  kdf: { alg: string; m_kib: number; t: number; p: number; salt: string };
  config_blob?: string;
  roster: { peer_id: string; pubkey?: string; joined_at_seq: number }[];
  /// True when the server acknowledges every DOC_UPDATE it stores. A server
  /// that predates acks omits it, and its updates are sent once and trusted.
  acks?: boolean;
  /// What this connection is held to, so a resend can be paced under it.
  limits?: { max_frame_bytes: number; frames_per_sec: number; bytes_per_sec: number };
}

export interface SocketEvents {
  onJoinAck(ack: JoinAck): void;
  onDocUpdate(sender: Uint8Array, envelope: Uint8Array): void;
  onSnapshot(sender: Uint8Array, covers: bigint, envelope: Uint8Array): void;
  onAwareness(sender: Uint8Array, plaintext: Uint8Array): void;
  onShredFrame(frameType: number, sender: Uint8Array, plaintext: Uint8Array): void;
  onPeerJoin(entry: RosterEntry): void;
  onPeerLeave(peerId: Uint8Array, reason?: number): void;
  onPurge(reason: string): void;
  onTtlExtended(addSecs: number, effectiveSecs: number, addedBy: string): void;
  onError(code: number): void;
  /// The document has outgrown a single snapshot frame, so its edit history
  /// can no longer be compacted.
  onSnapshotTooLarge(bytes: number): void;
  onEpochStale(epoch: number): void;
  onDisconnected(): void;
  /// This many of our document frames are now in the room log — or, against
  /// a server without acks, have been sent. The snapshot index is estimated
  /// from it.
  onUpdatesStored?(count: number): void;
  /// The server stops in this many seconds, taking every room with it.
  onRestartNotice?(inSecs: number): void;
  /// The server turned this connection away: 4007 when this address holds as
  /// many connections as one address may, 4008 when the server is full.
  onRefused?(code: number): void;
}

export interface SocketOptions {
  url: string;
  roomId: Uint8Array;
  authKey: Uint8Array;
  identity: Identity;
  contentKey: CryptoKey;
  events: SocketEvents;
  insecureAllowed?: boolean;
  maxBackoffMs?: number;
  /// Merge queued updates before a backlog is resent. Takes and returns
  /// wrapped payloads; without it every queued update goes out on its own.
  compactUpdates?: (wrapped: Uint8Array[]) => Uint8Array[];
  /// How long a sent update may go unacknowledged before the connection it
  /// went out on is treated as dead.
  ackTimeoutMs?: number;
}

const textDecoder = new TextDecoder();

interface Limits {
  maxFrameBytes: number;
  framesPerSec: number;
  bytesPerSec: number;
}

/// The server's defaults. Used until a JOIN_ACK says otherwise, and against a
/// server that predates advertising its limits.
const DEFAULT_LIMITS: Limits = {
  maxFrameBytes: 1024 * 1024,
  framesPerSec: 100,
  bytesPerSec: 1024 * 1024,
};

/// What encryption adds to a DOC_UPDATE plaintext on the wire: the header,
/// the nonce session and counter, and the GCM tag.
const DOC_FRAME_OVERHEAD = HEADER_LEN + 4 + 8 + 16;

/// An update unacknowledged for this long means the connection it went out on
/// has died without the browser noticing. A browser keeps such a socket OPEN
/// until TCP gives up, which takes minutes, and everything sent into it in
/// that time is lost.
const ACK_TIMEOUT_MS = 10_000;

/// Updates queued while disconnected are merged once there are this many,
/// rather than holding one entry per keystroke for the whole outage.
const COMPACT_WHILE_OFFLINE_AT = 256;

const REASSEMBLY_MAX_BYTES = 64 * 1024 * 1024;
const REASSEMBLY_MAX_GROUPS = 32;
/// A message whose parts stop arriving is abandoned after this long. Parts
/// can be orphaned legitimately — a sender whose connection died mid-message,
/// or a snapshot that compacted away the first parts of one already applied.
const REASSEMBLY_STALE_MS = 120_000;

/// A DOC_UPDATE too large for one frame travels as parts. Each part's
/// plaintext opens with a length no real payload can have, so a client that
/// predates parts reads one as a corrupt update and drops it rather than
/// applying half of something:
///
///   u32 0xFFFFFFFF ‖ message id (8 B) ‖ index u16 ‖ total u16 ‖ data length u32 ‖ data ‖ zero pad
///
/// The id is random and stays with the message across reconnects, so a part
/// that is sent twice is recognised as the same part.
export const PART_MARKER = 0xffffffff;
export const PART_HEADER_LEN = 20;

export function splitIntoParts(wrapped: Uint8Array, maxData: number, id: Uint8Array): Uint8Array[] {
  if (id.length !== 8) throw new Error("part id must be 8 bytes");
  const size = Math.max(1, Math.floor(maxData));
  const total = Math.ceil(wrapped.length / size);
  if (total < 2) throw new Error("an update that fits in one frame is not split");
  if (total > 0xffff) throw new Error("update too large to split");
  const parts: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const data = wrapped.subarray(i * size, Math.min(wrapped.length, (i + 1) * size));
    const unpadded = PART_HEADER_LEN + data.length;
    const rem = unpadded % 256;
    const out = new Uint8Array(unpadded + (rem === 0 ? 0 : 256 - rem));
    const view = new DataView(out.buffer);
    view.setUint32(0, PART_MARKER, false);
    out.set(id, 4);
    view.setUint16(12, i, false);
    view.setUint16(14, total, false);
    view.setUint32(16, data.length, false);
    out.set(data, PART_HEADER_LEN);
    parts.push(out);
  }
  return parts;
}

export interface Part {
  id: string;
  index: number;
  total: number;
  data: Uint8Array;
}

function isPart(plaintext: Uint8Array): boolean {
  return (
    plaintext.length >= 4 &&
    new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0, false) ===
      PART_MARKER
  );
}

/// Null for anything that is not a well-formed part.
export function readPart(plaintext: Uint8Array): Part | null {
  if (plaintext.length < PART_HEADER_LEN || !isPart(plaintext)) return null;
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const index = view.getUint16(12, false);
  const total = view.getUint16(14, false);
  const len = view.getUint32(16, false);
  if (total < 2 || index >= total || PART_HEADER_LEN + len > plaintext.length) return null;
  let id = "";
  for (let i = 4; i < 12; i++) id += plaintext[i].toString(16).padStart(2, "0");
  return { id, index, total, data: plaintext.slice(PART_HEADER_LEN, PART_HEADER_LEN + len) };
}

/// One update this client has written, held until the room has stored it.
interface Pending {
  wrapped: Uint8Array;
  /// Built the first time the update is found too large for one frame.
  parts: Uint8Array[] | null;
  /// Frames the server has confirmed storing.
  acked: number;
  /// Frames sent on the current connection, acknowledged or not.
  sent: number;
  /// The log refused it. Resending cannot help.
  refused: boolean;
}

interface Group {
  total: number;
  parts: (Uint8Array | undefined)[];
  have: number;
  bytes: number;
  at: number;
}

function limitsFrom(raw: JoinAck["limits"]): Limits {
  const pick = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback;
  return {
    maxFrameBytes: pick(raw?.max_frame_bytes, DEFAULT_LIMITS.maxFrameBytes, 4096, 8 * 1024 * 1024),
    framesPerSec: pick(raw?.frames_per_sec, DEFAULT_LIMITS.framesPerSec, 2, 1_000_000),
    bytesPerSec: pick(raw?.bytes_per_sec, DEFAULT_LIMITS.bytesPerSec, 4096, 2 ** 31),
  };
}

export class RunaSocket {
  private ws: WebSocket | null = null;
  private cipher: FrameCipher;
  private backoffMs = 250;
  private maxBackoffMs: number;
  private closedByUs = false;
  private epoch = 0;
  private peerId: Uint8Array = new Uint8Array(16);
  private joined = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly events: SocketEvents;

  /// Bumped whenever a connection starts or is lost, so work that awaited
  /// across the change can tell it is stale.
  private generation = 0;
  private acksEnabled = false;
  private limits: Limits = DEFAULT_LIMITS;
  private outbox: Pending[] = [];
  /// One entry per frame sent on the current connection and not yet
  /// acknowledged, in send order. The server acknowledges in the order it
  /// reads, so the head is always the frame an ack refers to.
  private inflight: { item: Pending; sentAt: number }[] = [];
  private pumping = false;
  private bucket = { frames: 0, bytes: 0, at: 0 };
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reassembly = new Map<string, Group>();
  private reassemblyBytes = 0;

  constructor(private opts: SocketOptions) {
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.cipher = new FrameCipher(opts.contentKey, opts.identity.publicKeyRaw);
    this.events = opts.events;
  }

  get sessionId(): Uint8Array {
    return this.cipher.sess;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  setEpoch(epoch: number): void {
    this.epoch = epoch;
  }

  async connect(): Promise<void> {
    if (this.closedByUs) return;
    const url = this.opts.url;
    if (url.startsWith("ws://") && !this.opts.insecureAllowed) {
      throw new Error("insecure ws:// refused; RUNA_ALLOW_INSECURE=1 required");
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    this.joined = false;
    this.generation += 1;
    ws.onopen = () => {
      void this.sendJoin();
    };
    ws.onmessage = (ev) => {
      void this.handleMessage(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.connectionLost();
      const code = (ev as CloseEvent | undefined)?.code;
      if (code === 4007 || code === 4008) this.events.onRefused?.(code);
      this.events.onDisconnected();
      if (!this.closedByUs) this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer) return;
    const jitterBytes = new Uint32Array(1);
    crypto.getRandomValues(jitterBytes);
    // `% 0` is NaN, and setTimeout(NaN) fires immediately — a hot reconnect
    // loop for any backoff under ~4 ms.
    const spread = Math.max(1, Math.floor(this.backoffMs * 0.3));
    const jitter = jitterBytes[0] % spread;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.cipher = new FrameCipher(this.opts.contentKey, this.opts.identity.publicKeyRaw);
      void this.connect().catch(() => this.scheduleReconnect());
    }, this.backoffMs + jitter);
  }

  /// Everything a connection held that dies with it. Queued updates survive:
  /// they are resent on the next connection.
  private connectionLost(): void {
    this.joined = false;
    this.generation += 1;
    this.inflight = [];
    this.stopLiveness();
  }

  /// Give up on a connection that has stopped acknowledging, without waiting
  /// for the browser to agree that it is dead. Closing it asks for a closing
  /// handshake the other end will never answer, and browsers wait up to a
  /// minute for that before reporting the close, so its handlers are detached
  /// and the reconnect starts now.
  private abandonConnection(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    this.connectionLost();
    this.events.onDisconnected();
    this.scheduleReconnect();
  }

  /// Forget everything queued or half-received. For when the room is gone or
  /// being wiped: there is nowhere left to send it, and it is document text.
  private discardQueues(): void {
    for (const item of this.outbox) {
      item.wrapped.fill(0);
      for (const p of item.parts ?? []) p.fill(0);
    }
    this.outbox = [];
    this.inflight = [];
    for (const g of this.reassembly.values()) for (const p of g.parts) p?.fill(0);
    this.reassembly.clear();
    this.reassemblyBytes = 0;
    this.stopLiveness();
  }

  /// Stop retrying without tearing down keys — used when the server says the
  /// room is gone, where reconnecting can only ever fail again.
  stopReconnecting(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.discardQueues();
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
  }

  close(): void {
    this.closedByUs = true;
    this.joined = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.discardQueues();
    this.ws?.close();
    this.ws = null;
    // Final teardown is the only point at which the auth key may be wiped.
    this.opts.authKey.fill(0);
  }

  /// Release this socket's handle on the content key during a wipe. The
  /// session clearing its own copy did not reach this one.
  ///
  /// Best-effort by nature: the cipher object keeps its own reference, and
  /// nulling that would leave every send path dereferencing null. What
  /// actually ends the key's life is the navigation to the tombstone that
  /// follows immediately — the keys are non-extractable `CryptoKey` handles,
  /// so they cannot leave the tab in the first place, and tearing down the
  /// realm takes them with it.
  dropKeys(): void {
    this.closedByUs = true;
    this.discardQueues();
    (this.opts as unknown as { contentKey: CryptoKey | null }).contentKey = null;
  }

  private async sendJoin(): Promise<void> {
    // Copy the key into the frame; the original must survive reconnects
    // (every reconnect re-runs the JOIN handshake). Zero the copy only.
    const keyCopy = this.opts.authKey.slice();
    const body = {
      auth_key: toB64(keyCopy),
      pubkey: toB64(this.opts.identity.publicKeyRaw),
      client_version: "runa/1.0",
      acks: true,
    };
    keyCopy.fill(0);
    const frame = buildJsonFrame(FT.JOIN, this.opts.roomId, this.epoch, body);
    this.ws?.send(frame);
  }

  private async handleMessage(bytes: Uint8Array): Promise<void> {
    const parsed = parseFrame(bytes);
    if (!parsed) return;
    const { header } = parsed;
    if (header.version !== PROTOCOL_VERSION) {
      this.events.onError(4005);
      return;
    }
    // Server-authored event frames carry epoch 0 by construction, so they
    // must be exempt from the staleness check or every one of them would be
    // dropped the moment the room's epoch advanced.
    const isServerEvent =
      header.frameType === FT.JOIN_ACK ||
      header.frameType === FT.ERROR ||
      header.frameType === FT.PEER_JOIN ||
      header.frameType === FT.PEER_LEAVE ||
      header.frameType === FT.PURGE ||
      header.frameType === FT.TTL_EXTEND ||
      header.frameType === FT.DOC_ACK ||
      header.frameType === FT.RESTART_NOTICE;
    if (!isServerEvent && header.epoch < this.epoch) {
      this.events.onEpochStale(header.epoch);
      return;
    }
    if (header.frameType === FT.JOIN_ACK) {
      // Exactly one JOIN_ACK per connection. A relay that replays it could
      // otherwise rewind this connection's nonce stream, and nonce reuse
      // under a shared AES-GCM key hands the relay the plaintext.
      if (this.joined) return;
      let ack: JoinAck;
      try {
        ack = JSON.parse(textDecoder.decode(parsed.body)) as JoinAck;
      } catch {
        return;
      }
      this.joined = true;
      this.epoch = ack.epoch ?? 0;
      // The AEAD sender component must be the server-assigned 16-byte peer id
      // (what receivers read from the envelope), not our public key. Re-label
      // in place: the nonce stream must never restart.
      this.peerId = fromB64(ack.peer_id);
      this.cipher.bindPeerId(this.peerId);
      // A successful join is what ends a run of failed attempts. The backoff
      // used to only ever grow, so a session that had reconnected a handful
      // of times waited fifteen seconds on every reconnect after that.
      this.backoffMs = 250;
      this.acksEnabled = ack.acks === true;
      this.limits = limitsFrom(ack.limits);
      this.bucket = { frames: this.limits.framesPerSec, bytes: this.limits.bytesPerSec, at: performance.now() };
      for (const item of this.outbox) item.sent = item.acked;
      this.compactOutbox();
      if (this.acksEnabled) this.startLiveness();
      this.events.onJoinAck(ack);
      void this.pump();
      return;
    }
    if (header.frameType === FT.DOC_ACK) {
      this.handleAck(parsed.body);
      return;
    }
    if (header.frameType === FT.RESTART_NOTICE) {
      try {
        const { in_secs } = JSON.parse(textDecoder.decode(parsed.body)) as { in_secs: unknown };
        if (typeof in_secs === "number" && Number.isFinite(in_secs) && in_secs >= 0) {
          this.events.onRestartNotice?.(Math.min(in_secs, 3600));
        }
      } catch {
        return;
      }
      return;
    }
    if (header.frameType === FT.ERROR) {
      let code = 4005;
      try {
        ({ code } = JSON.parse(textDecoder.decode(parsed.body)) as { code: number });
      } catch {
        /* malformed error frame: treat as a protocol error */
      }
      // 4001 covers "wrong key" and "no such room" — both are terminal. Left
      // to reconnect, a purged room turned every open tab into a client that
      // hammered the server every 15 seconds indefinitely.
      if (code === 4001 || code === 4010 || code === 4011) {
        this.closedByUs = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      }
      this.events.onError(code);
      return;
    }
    if (header.frameType === FT.TTL_EXTEND) {
      try {
        const j = JSON.parse(textDecoder.decode(parsed.body)) as {
          add_secs: number;
          effective_secs: number;
          remaining_secs?: number;
          added_by: string;
        };
        // The server clamps extensions at a ceiling, so re-anchor on the
        // value it computed rather than adding our own request locally.
        this.events.onTtlExtended(j.remaining_secs ?? j.effective_secs, j.effective_secs, j.added_by);
      } catch {
        return;
      }
      return;
    }
    if (header.frameType === FT.PURGE) {
      try {
        const { reason } = JSON.parse(textDecoder.decode(parsed.body)) as { reason: string };
        this.closedByUs = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.events.onPurge(reason);
      } catch {
        return;
      }
      return;
    }
    if (header.frameType === FT.PEER_JOIN) {
      try {
        const j = JSON.parse(textDecoder.decode(parsed.body)) as { peer_id: string; pubkey?: string; joined_at_seq: number };
        this.events.onPeerJoin({ peerId: fromB64(j.peer_id), pubkey: j.pubkey ? fromB64(j.pubkey) : undefined, joinedAtSeq: j.joined_at_seq });
      } catch {
        return;
      }
      return;
    }
    if (header.frameType === FT.PEER_LEAVE) {
      try {
        const j = JSON.parse(textDecoder.decode(parsed.body)) as { peer_id: string; reason?: number };
        this.events.onPeerLeave(fromB64(j.peer_id), j.reason);
      } catch {
        return;
      }
      return;
    }

    let env: EnvelopedFrame | null;
    try {
      env = stripEnvelope(bytes);
    } catch {
      return;
    }
    if (!env) return;
    const { senderId } = env;

    switch (header.frameType) {
      case FT.DOC_UPDATE: {
        try {
          const pt = await decryptEnvelope(
            this.opts.contentKey,
            bytes.slice(0, HEADER_LEN),
            senderId,
            env.body,
          );
          const whole = this.acceptPlaintext(pt);
          if (whole) this.events.onDocUpdate(senderId, whole);
        } catch {
          return;
        }
        return;
      }
      case FT.SNAPSHOT: {
        if (env.body.length < 8) return;
        const covers = snapshotCoversOf(env.body);
        try {
          const pt = await decryptEnvelope(
            this.opts.contentKey,
            bytes.slice(0, HEADER_LEN),
            senderId,
            env.body.slice(8),
            snapshotCoversOf(env.body),
          );
          this.events.onSnapshot(senderId, covers, pt);
        } catch {
          return;
        }
        return;
      }
      case FT.AWARENESS: {
        try {
          const pt = await decryptEnvelope(
            this.opts.contentKey,
            bytes.slice(0, HEADER_LEN),
            senderId,
            env.body,
          );
          this.events.onAwareness(senderId, pt);
        } catch {
          return;
        }
        return;
      }
      case FT.SHRED_REQUEST:
      case FT.SHRED_VOTE:
      case FT.SHRED_CANCEL:
      case FT.EPOCH_KEY: {
        try {
          const pt = await decryptEnvelope(
            this.opts.contentKey,
            bytes.slice(0, HEADER_LEN),
            senderId,
            env.body,
          );
          this.events.onShredFrame(header.frameType, senderId, pt);
        } catch {
          return;
        }
        return;
      }
      default:
        return;
    }
  }

  private handleAck(body: Uint8Array): void {
    let ok: boolean;
    try {
      ok = (JSON.parse(textDecoder.decode(body)) as { ok?: unknown }).ok === true;
    } catch {
      return;
    }
    const entry = this.inflight.shift();
    if (!entry) return;
    const { item } = entry;
    if (item.refused) return;
    if (!ok) {
      // The log is full. Resending cannot help, and the ERROR sent alongside
      // this has already told the person their edits did not reach anyone.
      item.refused = true;
      this.removeFromOutbox(item);
      return;
    }
    item.acked += 1;
    this.events.onUpdatesStored?.(1);
    if (item.acked >= this.framesFor(item).length) this.removeFromOutbox(item);
  }

  /// Receive one DOC_UPDATE plaintext. Returns a whole update to apply, or
  /// null while a split one is still arriving.
  private acceptPlaintext(pt: Uint8Array): Uint8Array | null {
    if (!isPart(pt)) return pt;
    const part = readPart(pt);
    if (!part) return null;
    this.pruneReassembly();
    let group = this.reassembly.get(part.id);
    if (group && group.total !== part.total) return null;
    if (!group) {
      group = { total: part.total, parts: new Array(part.total), have: 0, bytes: 0, at: performance.now() };
      this.reassembly.set(part.id, group);
    }
    if (group.parts[part.index]) return null;
    group.parts[part.index] = part.data;
    group.have += 1;
    group.bytes += part.data.length;
    group.at = performance.now();
    this.reassemblyBytes += part.data.length;
    if (group.have < group.total) {
      this.enforceReassemblyBounds(part.id);
      return null;
    }
    this.dropGroup(part.id, group);
    return concatBytes(...(group.parts as Uint8Array[]));
  }

  private dropGroup(id: string, group: Group): void {
    this.reassembly.delete(id);
    this.reassemblyBytes -= group.bytes;
  }

  private pruneReassembly(): void {
    const now = performance.now();
    for (const [id, g] of this.reassembly) {
      if (now - g.at > REASSEMBLY_STALE_MS) this.dropGroup(id, g);
    }
  }

  private enforceReassemblyBounds(current: string): void {
    while (this.reassembly.size > REASSEMBLY_MAX_GROUPS || this.reassemblyBytes > REASSEMBLY_MAX_BYTES) {
      let oldest: [string, Group] | null = null;
      for (const e of this.reassembly) {
        if (e[0] !== current && (!oldest || e[1].at < oldest[1].at)) oldest = e;
      }
      if (!oldest) {
        const g = this.reassembly.get(current);
        if (g) this.dropGroup(current, g);
        return;
      }
      this.dropGroup(oldest[0], oldest[1]);
    }
  }

  private ownHeader(frameType: number): Uint8Array {
    return encodeHeader({
      version: PROTOCOL_VERSION,
      frameType,
      roomId: this.opts.roomId,
      epoch: this.epoch,
      nonceSess: this.cipher.sess,
      flags: 0,
    });
  }

  /// Nothing encrypted may leave before JOIN_ACK. Until then the cipher is
  /// labelled with this client's public key instead of the peer id receivers
  /// will check it against, so every receiver rejects the frame — while the
  /// server, which cannot tell, stores a document update in the log for good
  /// and would compact history under a snapshot nobody can read.
  private canSendDocuments(): boolean {
    return this.joined && this.ws?.readyState === WebSocket.OPEN;
  }

  /// Queue an update for the room. It is sent once the connection is joined,
  /// and kept — across reconnects — until the server says it stored it.
  async sendUpdate(plaintext: Uint8Array): Promise<void> {
    if (this.closedByUs) return;
    this.outbox.push({ wrapped: plaintext, parts: null, acked: 0, sent: 0, refused: false });
    if (!this.joined && this.outbox.length >= COMPACT_WHILE_OFFLINE_AT) this.compactOutbox();
    void this.pump();
  }

  /// Whether a snapshot taken now would cover what it claims to: joined, with
  /// nothing of ours still unstored and nothing of anyone's half-received.
  readyForSnapshot(): boolean {
    this.pruneReassembly();
    return (
      this.canSendDocuments() &&
      this.outbox.length === 0 &&
      this.inflight.length === 0 &&
      this.reassembly.size === 0
    );
  }

  private framesFor(item: Pending): Uint8Array[] {
    if (item.parts) return item.parts;
    if (item.wrapped.length + DOC_FRAME_OVERHEAD <= this.limits.maxFrameBytes) return [item.wrapped];
    const id = new Uint8Array(8);
    crypto.getRandomValues(id);
    const room = this.limits.maxFrameBytes - DOC_FRAME_OVERHEAD - PART_HEADER_LEN - 255;
    item.parts = splitIntoParts(item.wrapped, Math.max(1024, Math.min(room, Math.floor(this.limits.bytesPerSec / 2))), id);
    return item.parts;
  }

  private removeFromOutbox(item: Pending): void {
    const i = this.outbox.indexOf(item);
    if (i >= 0) this.outbox.splice(i, 1);
  }

  /// Merge updates that have not been partly stored into fewer. A backlog of
  /// keystrokes resent one frame each is slow at a paced rate, and a split
  /// update keeps its parts so a resend completes the message it started.
  private compactOutbox(): void {
    const compact = this.opts.compactUpdates;
    if (!compact) return;
    const loose = this.outbox.filter((i) => i.acked === 0 && !i.parts && !i.refused);
    if (loose.length < 2) return;
    let merged: Uint8Array[];
    try {
      merged = compact(loose.map((i) => i.wrapped));
    } catch {
      return;
    }
    const looseSet = new Set(loose);
    this.outbox = [
      ...this.outbox.filter((i) => !looseSet.has(i)),
      ...merged.map((wrapped) => ({ wrapped, parts: null, acked: 0, sent: 0, refused: false })),
    ];
  }

  /// Send queued frames, one at a time and in order, for as long as the
  /// connection is joined. Order matters twice over: acks are matched to
  /// frames by position, and a part must not overtake the parts before it.
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.canSendDocuments()) {
        const item = this.outbox.find((i) => !i.refused && i.sent < this.framesFor(i).length);
        if (!item) return;
        const plaintext = this.framesFor(item)[item.sent];
        const gen = this.generation;
        await this.pace(plaintext.length + DOC_FRAME_OVERHEAD);
        if (gen !== this.generation || item.refused || !this.outbox.includes(item)) continue;
        if (!this.canSendDocuments()) return;
        const header = this.ownHeader(FT.DOC_UPDATE);
        const envelope = await this.cipher.encrypt(header, plaintext);
        if (gen !== this.generation) continue;
        if (!this.rawSend(concatBytes(header, envelope))) return;
        item.sent += 1;
        if (this.acksEnabled) {
          this.inflight.push({ item, sentAt: performance.now() });
        } else {
          item.acked = item.sent;
          this.events.onUpdatesStored?.(1);
          if (item.acked >= this.framesFor(item).length) this.removeFromOutbox(item);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /// Hold to half of the rate the server enforces. The rest is headroom for
  /// presence, shred frames and sync requests, which share the same limit.
  private async pace(bytes: number): Promise<void> {
    const frameRate = this.limits.framesPerSec / 2;
    const byteRate = this.limits.bytesPerSec / 2;
    const frameCap = this.limits.framesPerSec;
    const byteCap = Math.max(bytes, this.limits.bytesPerSec);
    for (;;) {
      const now = performance.now();
      const dt = Math.max(0, now - this.bucket.at) / 1000;
      this.bucket.at = now;
      this.bucket.frames = Math.min(frameCap, this.bucket.frames + dt * frameRate);
      this.bucket.bytes = Math.min(byteCap, this.bucket.bytes + dt * byteRate);
      if (this.bucket.frames >= 1 && this.bucket.bytes >= bytes) {
        this.bucket.frames -= 1;
        this.bucket.bytes -= bytes;
        return;
      }
      const waitFrames = this.bucket.frames >= 1 ? 0 : (1 - this.bucket.frames) / frameRate;
      const waitBytes = this.bucket.bytes >= bytes ? 0 : (bytes - this.bucket.bytes) / byteRate;
      await new Promise((r) => setTimeout(r, Math.max(1, Math.ceil(Math.max(waitFrames, waitBytes) * 1000))));
    }
  }

  private startLiveness(): void {
    this.stopLiveness();
    const timeout = this.opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    const gen = this.generation;
    this.livenessTimer = setInterval(() => {
      if (gen !== this.generation) {
        this.stopLiveness();
        return;
      }
      const oldest = this.inflight[0];
      if (oldest && performance.now() - oldest.sentAt > timeout) this.abandonConnection();
    }, Math.max(25, Math.min(1000, Math.floor(timeout / 4))));
  }

  private stopLiveness(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  async sendAwareness(plaintext: Uint8Array): Promise<void> {
    if (!this.canSendDocuments()) return;
    const header = this.ownHeader(FT.AWARENESS);
    const envelope = await this.cipher.encrypt(header, plaintext);
    this.rawSend(concatBytes(header, envelope));
  }

  async sendShredFrame(frameType: number, plaintext: Uint8Array): Promise<void> {
    if (!this.canSendDocuments()) return;
    const header = this.ownHeader(frameType);
    const envelope = await this.cipher.encrypt(header, plaintext);
    this.rawSend(concatBytes(header, envelope));
  }

  /// Throws when nothing was sent, so the caller does not move its sync index
  /// past history the server still holds.
  async sendSnapshot(plaintext: Uint8Array, covers: bigint): Promise<void> {
    if (!this.canSendDocuments()) throw new Error("not joined");
    // The truncation index rides outside the ciphertext but inside the AEAD:
    // a relay that rewrites it breaks authentication (amendment B).
    const header = this.ownHeader(FT.SNAPSHOT);
    const envelope = await this.cipher.encrypt(header, plaintext, covers);
    const body = new Uint8Array(8 + envelope.length);
    new DataView(body.buffer).setBigUint64(0, covers, false);
    body.set(envelope, 8);
    const frame = buildFrame(FT.SNAPSHOT, this.opts.roomId, this.epoch, this.cipher.sess, body);
    if (frame.length > this.limits.maxFrameBytes) {
      // Skipping leaves the log uncompacted, which is a slow problem.
      // Sending it closes the connection, which is an immediate one.
      this.events.onSnapshotTooLarge(frame.length);
      throw new Error("snapshot too large");
    }
    if (!this.rawSend(frame)) throw new Error("snapshot not sent");
  }

  sendSyncRequest(fromIndex: number): void {
    this.rawSend(
      buildJsonFrame(FT.DOC_SYNC_REQ, this.opts.roomId, this.epoch, { from_index: fromIndex }),
    );
  }

  sendTtlExtend(addSecs: number): void {
    this.rawSend(buildJsonFrame(FT.TTL_EXTEND, this.opts.roomId, this.epoch, { add_secs: addSecs }));
  }

  sendPurgeAck(requestId: string): void {
    this.rawSend(buildJsonFrame(FT.PURGE_ACK, this.opts.roomId, this.epoch, { request_id: requestId }));
  }

  /// Returns whether the bytes actually went out.
  private rawSend(bytes: Uint8Array): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
      return true;
    }
    return false;
  }
}

function snapshotCoversOf(envelope: Uint8Array): bigint {
  let c = 0n;
  for (let i = 0; i < 8; i++) c = (c << 8n) | BigInt(envelope[i]);
  return c;
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type { FrameHeader };
export { HEADER_LEN };
