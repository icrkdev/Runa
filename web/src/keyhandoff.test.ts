// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { securityLevelOf } from "./security-level";

const ID = "2cbc36d4e6f0fb26d9278c0c93d34c01";
const OTHER = "ffffffffffffffffffffffffffffffff";
const KEY = "#k=LrJqsoYvcU5MLF2XsxsPFvOjM7mhbhR7V9pCqp6dgFg&s=he3sBsMgfx1BA2CobezDog";

/// A fresh copy of the module, as a page load gets: whatever it held in
/// memory is gone, and only the address and the tab's history state remain.
async function load() {
  vi.resetModules();
  return import("./keyhandoff");
}

beforeEach(() => {
  history.replaceState(null, "", "/");
});

describe("where an unlisted room's key goes", () => {
  it("is taken out of the address bar the moment a clicked link is opened", async () => {
    history.replaceState(null, "", `/r/${ID}${KEY}`);
    const { takeRoomKey } = await load();
    expect(takeRoomKey(ID)).toBe(KEY);
    expect(location.hash).toBe("");
    expect(location.href).not.toContain("#k=");
    expect(location.pathname).toBe(`/r/${ID}`);
  });

  it("answers a second ask the same way, as React's strict mode makes", async () => {
    history.replaceState(null, "", `/r/${ID}${KEY}`);
    const { takeRoomKey } = await load();
    expect(takeRoomKey(ID)).toBe(KEY);
    expect(takeRoomKey(ID)).toBe(KEY);
  });

  it("never writes the key into the address when the app opens a room itself", async () => {
    const { openUnlistedRoom, takeRoomKey } = await load();
    const seen: string[] = [];
    const onPop = () => seen.push(location.href);
    window.addEventListener("popstate", onPop);
    openUnlistedRoom(ID, KEY);
    window.removeEventListener("popstate", onPop);
    expect(location.pathname).toBe(`/r/${ID}`);
    expect(location.href).not.toContain("#k=");
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("#k=");
    expect(takeRoomKey(ID)).toBe(KEY);
  });

  it("does not hand one room's key to another", async () => {
    const { openUnlistedRoom, takeRoomKey } = await load();
    openUnlistedRoom(ID, KEY);
    expect(takeRoomKey(OTHER)).toBeUndefined();
  });

  it("survives a refresh in an everyday room, from the tab's state and not the address", async () => {
    const first = await load();
    first.openUnlistedRoom(ID, KEY);
    first.applySecurityLevel(ID, KEY, "everyday");
    expect(location.href).not.toContain("#k=");

    const afterRefresh = await load();
    expect(afterRefresh.takeRoomKey(ID)).toBe(KEY);
    expect(afterRefresh.takeRoomKey(OTHER)).toBeUndefined();
  });

  it("is forgotten by a refresh in a highest-security room", async () => {
    const first = await load();
    first.openUnlistedRoom(ID, KEY);
    first.applySecurityLevel(ID, KEY, "highest");
    expect(history.state).toBeNull();

    const afterRefresh = await load();
    expect(afterRefresh.takeRoomKey(ID)).toBeUndefined();
  });

  it("clears a key an earlier everyday visit saved, once the room says highest", async () => {
    const first = await load();
    first.openUnlistedRoom(ID, KEY);
    first.applySecurityLevel(ID, KEY, "everyday");
    first.applySecurityLevel(ID, KEY, "highest");
    const afterRefresh = await load();
    expect(afterRefresh.takeRoomKey(ID)).toBeUndefined();
  });

  it("is not kept from a clicked link until the room has said it may be", async () => {
    history.replaceState(null, "", `/r/${ID}${KEY}`);
    const first = await load();
    first.takeRoomKey(ID);
    const afterRefresh = await load();
    expect(afterRefresh.takeRoomKey(ID)).toBeUndefined();
  });

  it("rebuilds the whole shareable link from memory", async () => {
    const { shareLink } = await load();
    expect(shareLink(ID, KEY)).toBe(`${location.origin}/r/${ID}${KEY}`);
  });
});

describe("which level a member applies", () => {
  it("is the sealed config's, when it opens", () => {
    expect(securityLevelOf({ level: "everyday" })).toBe("everyday");
    expect(securityLevelOf({ level: "highest" })).toBe("highest");
  });

  it("is the strictest when the config is missing or will not open", () => {
    expect(securityLevelOf(null)).toBe("highest");
    expect(securityLevelOf(undefined)).toBe("highest");
  });
});
