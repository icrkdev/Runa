import { webcrypto as crypto } from "node:crypto";
import { createHash } from "node:crypto";
import WebSocket from "ws";

const BASE = process.env.RUNA_URL ?? "http://127.0.0.1:3000";
const CANARY = "RUNA-CANARY-" + crypto.randomUUID();

const enc = new TextEncoder();
const INFO_AUTH = enc.encode("runa/v1/auth");
const INFO_CONTENT = enc.encode("runa/v1/content");

const FT = { JOIN: 0x01, JOIN_ACK: 0x02, DOC_UPDATE: 0x03, ERROR: 0x30 };

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

async function deriveKeys(linkSecret, salt) {
  const [authKey, contentRaw] = await Promise.all([
    hkdf(linkSecret, salt, INFO_AUTH, 32),
    hkdf(linkSecret, salt, INFO_CONTENT, 32),
  ]);
  const contentKey = await crypto.subtle.importKey(
    "raw",
    contentRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  contentRaw.fill(0);
  return { authKey, contentKey };
}

function buildHeader(frameType, roomId, sess) {
  const h = new Uint8Array(32);
  h[0] = 0x52; h[1] = 0x55; h[2] = 0x01; h[3] = frameType;
  h.set(roomId, 4);
  const dv = new DataView(h.buffer);
  dv.setUint32(20, 0, false);
  h.set(sess, 24);
  dv.setUint32(28, 0, false);
  return h;
}

function counterBytes(counter) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(counter);
  return b;
}

function buildAad(header, senderId, counter) {
  // "runa/v1" || header(32) || sender(16) || counter(8) || covers(8, zero)
  return Buffer.concat([
    Buffer.from("runa/v1"),
    Buffer.from(header),
    Buffer.from(senderId),
    counterBytes(counter),
    counterBytes(0n),
  ]);
}

class Client {
  constructor(name, roomId, keys, ws) {
    this.name = name;
    this.roomId = roomId;
    this.keys = keys;
    this.ws = ws;
    this.sess = crypto.getRandomValues(new Uint8Array(4));
    this.counter = 0n;
    this.peerId = null;
    this.error = null;
    this.frames = [];
    this.waiters = [];
    ws.on("message", (data) => this.onFrame(new Uint8Array(data)));
  }

  onFrame(bytes) {
    this.frames.push(Buffer.from(bytes));
    const ft = bytes[3];
    if (ft === FT.JOIN_ACK) {
      this.peerId = JSON.parse(new TextDecoder().decode(bytes.slice(32))).peer_id;
    }
    if (ft === FT.ERROR) {
      this.error = JSON.parse(new TextDecoder().decode(bytes.slice(32))).code;
    }
    const still = [];
    for (const w of this.waiters) {
      if (!w.done && w.ft === ft) { w.done = true; w.resolve(); }
      else still.push(w);
    }
    this.waiters = still;
  }

  waitFor(frameType, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        ft: frameType,
        done: false,
        resolve: () => { clearTimeout(timer); resolve(); },
      };
      timer = setTimeout(
        () => reject(new Error(`${this.name}: timeout waiting for frame type ${frameType}`)),
        timeoutMs,
      );
      this.waiters.push(entry);
    });
  }

  lastFrame() {
    return this.frames[this.frames.length - 1];
  }

  send(frame) {
    this.ws.send(frame);
  }

  async sendDocUpdate(plaintext) {
    const counter = this.counter;
    this.counter += 1n;

    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(plaintext.length);
    const inner = Buffer.concat([lenPrefix, Buffer.from(plaintext)]);
    const wrapped = Buffer.alloc(Math.ceil(inner.length / 256) * 256);
    inner.copy(wrapped);

    const nonce = Buffer.concat([Buffer.from(this.sess), counterBytes(counter)]);
    const header = Buffer.concat([
      Buffer.from([0x52, 0x55, 0x01, FT.DOC_UPDATE]),
      Buffer.from(this.roomId),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from(this.sess),
      Buffer.from([0, 0, 0, 0]),
    ]);
    const aad = buildAad(header, Buffer.from(this.peerId, "base64"), counter);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
        this.keys.contentKey,
        wrapped,
      ),
    );
    const envelope = Buffer.concat([Buffer.from(this.sess), counterBytes(counter), Buffer.from(ct)]);
    this.ws.send(Buffer.concat([Buffer.from(buildHeader(FT.DOC_UPDATE, this.roomId, this.sess)), envelope]));
  }

  async nextDocUpdatePlaintext() {
    await this.waitFor(FT.DOC_UPDATE);
    const bytes = this.lastFrame();
    const sender = bytes.slice(32, 48);
    const sess = bytes.slice(48, 52);
    const counter = bytes.readBigUInt64BE(52);
    const ct = bytes.slice(60);
    const aad = buildAad(bytes.slice(0, 32), sender, counter);
    const nonce = Buffer.concat([Buffer.from(sess), counterBytes(counter)]);
    const pt = Buffer.from(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
        this.keys.contentKey,
        ct,
      ),
    );
    const len = pt.readUInt32BE(0);
    return pt.toString("utf8", 4, 4 + len);
  }

  close() {
    this.ws.close();
  }
}

function connectWs(base, roomIdHex) {
  const url = `${base.replace(/^http/, "ws")}/socket/${roomIdHex}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "nodebuffer";
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function main() {
  const linkSecret = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const roomId = crypto.getRandomValues(new Uint8Array(16));
  const roomIdHex = hex(roomId);

  const { authKey, contentKey } = await deriveKeys(linkSecret, salt);
  const verifier = createHash("sha256").update(authKey).digest().toString("base64");
  authKey.fill(0);

  const createRes = await fetch(`${BASE}/api/rooms/unlisted`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: roomIdHex,
      verifier,
      kdf: { m_kib: 65536, t: 3, p: 1, salt: b64(salt) },
      ttl: { kind: "idle-peers", secs: 3600 },
    }),
  });
  if (createRes.status !== 201) {
    throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`);
  }

  const makeJoinBody = async () =>
    JSON.stringify({
      auth_key: b64((await deriveKeys(linkSecret, salt)).authKey),
      pubkey: b64(crypto.getRandomValues(new Uint8Array(32))),
    });

  const wsA = await connectWs(BASE, roomIdHex);
  const a = new Client("A", roomId, { contentKey }, wsA);
  a.send(Buffer.concat([
    Buffer.from(buildHeader(FT.JOIN, roomId, a.sess)),
    Buffer.from(await makeJoinBody()),
  ]));
  await a.waitFor(FT.JOIN_ACK);
  if (!a.peerId) throw new Error("A: no peer id in JOIN_ACK");

  const wsB = await connectWs(BASE, roomIdHex);
  const b = new Client("B", roomId, { contentKey }, wsB);
  b.send(Buffer.concat([
    Buffer.from(buildHeader(FT.JOIN, roomId, b.sess)),
    Buffer.from(await makeJoinBody()),
  ]));
  await b.waitFor(FT.JOIN_ACK);
  if (!b.peerId) throw new Error("B: no peer id in JOIN_ACK");
  if (a.peerId === b.peerId) throw new Error("server issued duplicate peer ids");

  await a.sendDocUpdate(enc.encode(CANARY));
  const atB = await b.nextDocUpdatePlaintext();
  if (atB !== CANARY) throw new Error(`B decoded wrong plaintext: "${atB}"`);

  await b.sendDocUpdate(enc.encode("reply-from-b"));
  const atA = await a.nextDocUpdatePlaintext();
  if (atA !== "reply-from-b") throw new Error(`A decoded wrong plaintext: "${atA}"`);

  const wireTexts = [...a.frames, ...b.frames].map((f) => f.toString("latin1"));
  const leaked = wireTexts.filter((t) => t.includes(CANARY) || t.includes("reply-from-b"));
  if (leaked.length > 0) throw new Error("PLAINTEXT LEAKED ON THE WIRE");

  const wsC = await connectWs(BASE, roomIdHex);
  const c = new Client("C", roomId, { contentKey }, wsC);
  c.send(Buffer.concat([
    Buffer.from(buildHeader(FT.JOIN, roomId, c.sess)),
    Buffer.from(JSON.stringify({ auth_key: b64(crypto.getRandomValues(new Uint8Array(32))) })),
  ]));
  await c.waitFor(FT.ERROR);
  if (c.error !== 4001) throw new Error(`expected generic 4001 for wrong key, got ${c.error}`);

  a.close(); b.close(); c.close();

  console.log("E2E SMOKE OK");
  console.log(`  room     ${roomIdHex}`);
  console.log(`  peers    A=${a.peerId}  B=${b.peerId}`);
  console.log(`  frames   ${a.frames.length + b.frames.length} captured on the wire`);
  console.log(`  canary   delivered A->B and B->A encrypted; zero plaintext hits in wire capture`);
  console.log(`  auth     wrong key rejected with generic 4001`);
  process.exit(0);
}

main().catch((e) => {
  console.error("E2E SMOKE FAILED:", e.message);
  console.error(e.stack?.split(String.fromCharCode(10)).slice(0, 10).join(String.fromCharCode(10)) ?? e);
  process.exit(1);
});
