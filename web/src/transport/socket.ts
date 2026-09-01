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
  ceiling_optout: boolean;
  kdf: { alg: string; m_kib: number; t: number; p: number; salt: string };
  config_blob?: string;
  roster: { peer_id: string; pubkey?: string; joined_at_seq: number }[];
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
  onEpochStale(epoch: number): void;
  onDisconnected(): void;
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
}

const textDecoder = new TextDecoder();

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
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.joined = false;
    this.ws.onopen = () => {
      void this.sendJoin();
    };
    this.ws.onmessage = (ev) => {
      void this.handleMessage(new Uint8Array(ev.data as ArrayBuffer));
    };
    this.ws.onclose = () => {
      this.events.onDisconnected();
      if (!this.closedByUs) this.scheduleReconnect();
    };
    this.ws.onerror = () => {};
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

  close(): void {
    this.closedByUs = true;
    this.joined = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
      header.frameType === FT.TTL_EXTEND;
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
      this.events.onJoinAck(ack);
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
          this.events.onDocUpdate(senderId, pt);
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

  async sendUpdate(plaintext: Uint8Array): Promise<void> {
    const header = this.ownHeader(FT.DOC_UPDATE);
    const envelope = await this.cipher.encrypt(header, plaintext);
    this.rawSend(concatBytes(header, envelope));
  }

  async sendAwareness(plaintext: Uint8Array): Promise<void> {
    const header = this.ownHeader(FT.AWARENESS);
    const envelope = await this.cipher.encrypt(header, plaintext);
    this.rawSend(concatBytes(header, envelope));
  }

  async sendShredFrame(frameType: number, plaintext: Uint8Array): Promise<void> {
    const header = this.ownHeader(frameType);
    const envelope = await this.cipher.encrypt(header, plaintext);
    this.rawSend(concatBytes(header, envelope));
  }

  async sendSnapshot(plaintext: Uint8Array, covers: bigint): Promise<void> {
    // The truncation index rides outside the ciphertext but inside the AEAD:
    // a relay that rewrites it breaks authentication (amendment B).
    const header = this.ownHeader(FT.SNAPSHOT);
    const envelope = await this.cipher.encrypt(header, plaintext, covers);
    const body = new Uint8Array(8 + envelope.length);
    new DataView(body.buffer).setBigUint64(0, covers, false);
    body.set(envelope, 8);
    this.rawSend(buildFrame(FT.SNAPSHOT, this.opts.roomId, this.epoch, this.cipher.sess, body));
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

  private rawSend(bytes: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
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
