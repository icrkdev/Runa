import { createHash } from "node:crypto";
import { webcrypto } from "node:crypto";

const ROOM = Buffer.alloc(16, 0x21);

async function main(n) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const sessA = new Uint8Array(4);
  const sessB = new Uint8Array(4);
  webcrypto.getRandomValues(sessA);
  webcrypto.getRandomValues(sessB);

  const seen = new Set();
  const bigEndian = (c) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(c);
    return b;
  };
  const counters = { a: 0n, b: 0n };

  const started = Date.now();
  let ops = 0;
  for (let i = 0; i < n; i++) {
    for (const name of ["a", "b"]) {
      const sess = name === "a" ? sessA : sessB;
      const c = counters[name];
      counters[name] = c + 1n;
      const id = createHash("sha256")
        .update(Buffer.concat([Buffer.from(sess), bigEndian(c), ROOM]))
        .digest()
        .toString("hex");
      if (seen.has(id)) {
        console.error(`COLLISION at iteration ${i} session ${name}`);
        process.exit(1);
      }
      seen.add(id);
      ops += 1;
    }
    if (i % 1000 === 0) {
      const pt = new Uint8Array(32);
      webcrypto.getRandomValues(pt);
      await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv: new Uint8Array([...sessA, ...bigEndian(counters.a)].slice(0, 12)), tagLength: 128 },
        key,
        pt,
      );
    }
  }
  console.log(`OK: ${ops} unique nonces across two sessions in ${Date.now() - started}ms`);
}

main(Number(process.argv[2] ?? "10000000"));
