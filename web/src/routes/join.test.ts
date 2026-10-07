import { describe, expect, it } from "vitest";
import { readJoinTarget } from "./join";

const HERE = "https://runa.example.com";
const ID = "2cbc36d4e6f0fb26d9278c0c93d34c01";
const KEY = "#k=LrJqsoYvcU5MLF2XsxsPFvOjM7mhbhR7V9pCqp6dgFg&s=he3sBsMgfx1BA2CobezDog";

describe("reading what someone pastes into Join", () => {
  it("opens a whole private link, key and all", () => {
    expect(readJoinTarget(`${HERE}/r/${ID}${KEY}`, HERE)).toEqual({
      kind: "private",
      href: `/r/${ID}${KEY}`,
      elsewhere: null,
      roomIdHex: ID,
      fragment: KEY,
    });
  });

  it("copes with the scheme lost, a trailing slash, capitals and stray spaces", () => {
    for (const pasted of [
      `runa.example.com/r/${ID}${KEY}`,
      `  ${HERE}/r/${ID}/${KEY}\n`,
      `${HERE}/r/${ID.toUpperCase()}${KEY}`,
      `/r/${ID}${KEY}`,
      `r/${ID}${KEY}`,
      `${ID}${KEY}`,
    ]) {
      expect(readJoinTarget(pasted, HERE), pasted).toMatchObject({
        kind: "private",
        href: `/r/${ID}${KEY}`,
        roomIdHex: ID,
        fragment: KEY,
      });
    }
  });

  it("keeps a link from another RÚNA server pointed at that server", () => {
    expect(readJoinTarget(`https://other.example/r/${ID}${KEY}`, HERE)).toEqual({
      kind: "private",
      href: `https://other.example/r/${ID}${KEY}`,
      elsewhere: "other.example",
      roomIdHex: ID,
      fragment: KEY,
    });
  });

  it("says when a private room has lost its key, or the key is damaged", () => {
    expect(readJoinTarget(ID, HERE)).toEqual({ kind: "private-no-key", href: `/r/${ID}`, damaged: false });
    expect(readJoinTarget(`${HERE}/r/${ID}`, HERE)).toMatchObject({ kind: "private-no-key", damaged: false });
    expect(readJoinTarget(`${ID}#k=short&s=x`, HERE)).toMatchObject({ kind: "private-no-key", damaged: true });
  });

  it("opens a shared room by name, by address, or by its old /n/ address", () => {
    for (const pasted of ["copper-lantern", "Copper-Lantern", `${HERE}/copper-lantern`, "runa.example.com/copper-lantern", "/n/copper-lantern", `${HERE}/n/copper-lantern/`]) {
      expect(readJoinTarget(pasted, HERE), pasted).toMatchObject({ kind: "named", href: "/copper-lantern", name: "copper-lantern" });
    }
    expect(readJoinTarget("meow1", HERE)).toMatchObject({ kind: "named", name: "meow1" });
  });

  it("turns away what cannot be a room, with a reason", () => {
    expect(readJoinTarget("", HERE)).toEqual({ kind: "nothing" });
    expect(readJoinTarget("copper lantern", HERE)).toMatchObject({ kind: "unrecognised" });
    expect(readJoinTarget("standup", HERE)).toMatchObject({ kind: "unrecognised" });
    expect(readJoinTarget("https://example.com/some/page", HERE)).toMatchObject({ kind: "unrecognised" });
    expect(readJoinTarget("javascript:alert(1)", HERE)).toMatchObject({ kind: "unrecognised" });
    expect(readJoinTarget(`ftp://x.example/r/${ID}${KEY}`, HERE)).toMatchObject({ kind: "unrecognised" });
  });

  it("will not be fooled by an address that hides its real host behind an @", () => {
    for (const pasted of [
      `https://runa.example.com@evil.example/r/${ID}${KEY}`,
      "https://runa.example.com:pw@evil.example/copper-lantern",
    ]) {
      const t = readJoinTarget(pasted, HERE);
      expect(t, pasted).toMatchObject({ kind: "unrecognised" });
      if (t.kind === "unrecognised") expect(t.reason, pasted).toContain("evil.example");
    }
    // Without a scheme it is not read as a link at all.
    expect(readJoinTarget("runa.example.com@evil.example/copper-lantern", HERE)).toMatchObject({ kind: "unrecognised" });
  });

  it("will not hand a key to a room served in the clear", () => {
    for (const pasted of [`http://other.example/r/${ID}${KEY}`, "http://other.example/copper-lantern", `http://192.168.1.5/r/${ID}${KEY}`]) {
      const t = readJoinTarget(pasted, HERE);
      expect(t, pasted).toMatchObject({ kind: "unrecognised" });
      if (t.kind === "unrecognised") expect(t.reason, pasted).toContain("plain http");
    }
  });

  it("opens an onion, or this machine, over http — the two places that is safe", () => {
    const onion = "xv5fx5v7kfatx7sg3ws7o3rqaixfndxmp2mplinkwdt67ghzi5rltgad.onion";
    expect(readJoinTarget(`http://${onion}/r/${ID}${KEY}`, HERE)).toMatchObject({ kind: "private", elsewhere: onion });
    expect(readJoinTarget(`${onion}/copper-lantern`, HERE)).toMatchObject({ kind: "named", href: `http://${onion}/copper-lantern` });
    expect(readJoinTarget(`http://localhost:3000/r/${ID}${KEY}`, HERE)).toMatchObject({ kind: "private", elsewhere: "localhost:3000" });
  });

  it("reads a link pasted without its scheme as https, even from a page served over http", () => {
    const onionPage = "http://xv5fx5v7kfatx7sg3ws7o3rqaixfndxmp2mplinkwdt67ghzi5rltgad.onion";
    expect(readJoinTarget(`other.example/r/${ID}${KEY}`, onionPage)).toMatchObject({
      kind: "private",
      href: `https://other.example/r/${ID}${KEY}`,
    });
    expect(readJoinTarget("xv5fx5v7kfatx7sg3ws7o3rqaixfndxmp2mplinkwdt67ghzi5rltgad.onion/copper-lantern", onionPage)).toMatchObject({
      kind: "named",
      href: "/copper-lantern",
      elsewhere: null,
    });
  });

  it("turns away a host no server could have", () => {
    for (const pasted of ['https://o"ther.example/copper-lantern', "https://other..example/copper-lantern", "https://a&b.example/copper-lantern"]) {
      expect(readJoinTarget(pasted, HERE), pasted).toMatchObject({ kind: "unrecognised" });
    }
  });
});
