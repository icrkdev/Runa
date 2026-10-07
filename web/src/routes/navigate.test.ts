import { describe, expect, it } from "vitest";
import { isSafeDestination } from "./navigate";
import { readJoinTarget } from "./join";

const HERE = "https://runa.example.com";
const ID = "2cbc36d4e6f0fb26d9278c0c93d34c01";
const KEY = "#k=LrJqsoYvcU5MLF2XsxsPFvOjM7mhbhR7V9pCqp6dgFg&s=he3sBsMgfx1BA2CobezDog";

describe("where Join and Create may send the page", () => {
  it("allows a path on this server, key fragment and all", () => {
    expect(isSafeDestination("/copper-lantern", HERE)).toBe(true);
    expect(isSafeDestination(`/r/${ID}${KEY}`, HERE)).toBe(true);
  });

  it("allows a room on another RÚNA server over https, or over http only to an onion or this machine", () => {
    expect(isSafeDestination(`https://other.example/r/${ID}${KEY}`, HERE)).toBe(true);
    expect(isSafeDestination("http://xv5fx5v7kfatx7sg3ws7o3rqaixfndxmp2mplinkwdt67ghzi5rltgad.onion/copper-lantern", HERE)).toBe(true);
    expect(isSafeDestination(`http://localhost:3000/r/${ID}${KEY}`, HERE)).toBe(true);
    expect(isSafeDestination(`http://127.0.0.1:3000/r/${ID}${KEY}`, HERE)).toBe(true);
    expect(isSafeDestination(`http://[::1]:3000/r/${ID}${KEY}`, HERE)).toBe(true);
  });

  it("refuses scripts, data, disguised hosts, cleartext keys, and anything that only looks like a path", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "//evil.com/r",
      "/\\evil.com/r",
      "\\\\evil.com/r",
      "/\t/evil.com/r",
      "/\n/evil.com/r",
      "copper-lantern",
      "",
      "ftp://other.example/r",
      `http://other.example/r/${ID}${KEY}`,
      `http://192.168.1.5/r/${ID}${KEY}`,
      "http://onion.example/copper-lantern",
      "https://runa.example.com@evil.example/copper-lantern",
      "https://user:pw@other.example/copper-lantern",
      'https://o"ther.example/copper-lantern',
    ]) {
      expect(isSafeDestination(hostile, HERE), JSON.stringify(hostile)).toBe(false);
    }
  });

  it("lets through everything Join can open", () => {
    for (const pasted of [
      `${HERE}/r/${ID}${KEY}`,
      `https://other.example/r/${ID}${KEY}`,
      "copper-lantern",
      "https://other.example/copper-lantern",
    ]) {
      const t = readJoinTarget(pasted, HERE);
      if (t.kind !== "private" && t.kind !== "named") throw new Error(`${pasted} did not open`);
      expect(isSafeDestination(t.href, HERE), pasted).toBe(true);
    }
  });

  it("never opens anywhere unsafe, whatever is pasted", () => {
    // Deterministic mutations of hostile and ordinary input: whatever Join
    // agrees to open must pass the guard at the sink.
    const seeds = [
      "javascript:alert(1)", "data:text/html,x", "//evil.example/copper-lantern", "/\\evil.example/copper-lantern",
      "https://runa.example.com@evil.example/copper-lantern", `http://other.example/r/${ID}${KEY}`,
      `https://other.example/r/${ID}${KEY}`, "copper-lantern", `${HERE}/r/${ID}${KEY}`, "evil.example/copper-lantern",
      `http://abc.onion/r/${ID}${KEY}`, `http://localhost:3000/r/${ID}${KEY}`,
    ];
    const bits = ["/", "\\", ":", "#", "@", "%", "?", "&", "=", "<", "\"", "'", "\t", "\n", " ", ".", "-", "a", "javascript:", "//", "http://", "https://", "evil.example", "copper-lantern", `r/${ID}`, KEY, "\u0000"];
    let state = 42;
    const rnd = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    let opened = 0;
    for (let i = 0; i < 5000; i++) {
      let s = seeds[rnd(seeds.length)];
      for (let j = 0, m = 1 + rnd(4); j < m; j++) {
        const at = rnd(s.length + 1);
        s = s.slice(0, at) + bits[rnd(bits.length)] + s.slice(at + rnd(2));
      }
      const t = readJoinTarget(s, HERE);
      if (t.kind !== "private" && t.kind !== "named") continue;
      opened++;
      expect(isSafeDestination(t.href, HERE), JSON.stringify(s)).toBe(true);
    }
    expect(opened).toBeGreaterThan(100);
  });
});
