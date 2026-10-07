import { describe, expect, it } from "vitest";
import { navigableHref } from "./navigate";
import { readJoinTarget } from "./join";

const HERE = "https://runa.example.com";
const ID = "2cbc36d4e6f0fb26d9278c0c93d34c01";
const KEY = "#k=LrJqsoYvcU5MLF2XsxsPFvOjM7mhbhR7V9pCqp6dgFg&s=he3sBsMgfx1BA2CobezDog";

describe("where Join and Create may send the page", () => {
  it("allows a path on this server, key fragment intact", () => {
    expect(navigableHref("/copper-lantern", HERE)).toBe("/copper-lantern");
    expect(navigableHref(`/r/${ID}${KEY}`, HERE)).toBe(`/r/${ID}${KEY}`);
  });

  it("allows a room on another RÚNA server, over https or http", () => {
    expect(navigableHref(`https://other.example/r/${ID}${KEY}`, HERE)).toBe(`https://other.example/r/${ID}${KEY}`);
    const onion = "http://xv5fx5v7kfatx7sg3ws7o3rqaixfndxmp2mplinkwdt67ghzi5rltgad.onion/copper-lantern";
    expect(navigableHref(onion, HERE)).toBe(onion);
  });

  it("refuses scripts, data, and anything that only looks like a path", () => {
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
    ]) {
      expect(navigableHref(hostile, HERE), JSON.stringify(hostile)).toBeNull();
    }
  });

  it("lets through everything Join can open, unchanged", () => {
    for (const pasted of [
      `${HERE}/r/${ID}${KEY}`,
      `https://other.example/r/${ID}${KEY}`,
      "copper-lantern",
      "https://other.example/copper-lantern",
    ]) {
      const t = readJoinTarget(pasted, HERE);
      if (t.kind !== "private" && t.kind !== "named") throw new Error(`${pasted} did not open`);
      expect(navigableHref(t.href, HERE), pasted).toBe(t.href);
    }
  });
});
