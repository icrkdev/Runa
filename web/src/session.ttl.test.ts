import { describe, expect, it } from "vitest";
import { absoluteTtlShortened } from "./session";

const ABS = (secs: number) => ({ kind: "absolute", secs });

describe("an absolute TTL is only a mismatch when the server actually shortened it", () => {
  it("does not flag a 24-hour room a minute after it was made", () => {
    // The reported bug, at the point it becomes visible. One second of elapsed
    // time sits exactly on the rounding tolerance and slips through the old
    // comparison too, so it proves nothing; a minute is where every 24-hour
    // room started reporting its own server as untrustworthy.
    expect(absoluteTtlShortened(ABS(86_400), ABS(86_340), 60)).toBe(false);
  });

  it("does not flag a 24-hour room most of the way through its life", () => {
    expect(absoluteTtlShortened(ABS(86_400), ABS(120), 86_280)).toBe(false);
  });

  it("does not flag a room that has expired down to zero", () => {
    expect(absoluteTtlShortened(ABS(86_400), ABS(0), 86_400)).toBe(false);
  });

  it("flags a server claiming an hour where the config says a day", () => {
    // remaining 3_500 + elapsed 100 = 3_600, far short of 86_400.
    expect(absoluteTtlShortened(ABS(86_400), ABS(3_500), 100)).toBe(true);
  });

  it("flags a shortening even late in the room's life", () => {
    // 80_000 elapsed of a day leaves 6_400; claiming 60 means it dies early.
    expect(absoluteTtlShortened(ABS(86_400), ABS(60), 80_000)).toBe(true);
  });

  it("tolerates a second of rounding either way", () => {
    expect(absoluteTtlShortened(ABS(86_400), ABS(86_399), 0)).toBe(false);
  });

  it("does not flag a room that was extended, since extensions only add", () => {
    // effective_ttl_secs is the configured value plus any TTL_EXTEND.
    expect(absoluteTtlShortened(ABS(86_400), ABS(90_000), 10)).toBe(false);
  });

  it("cannot check without elapsed, and says so rather than guessing", () => {
    // A server predating the field. False, not true: an unverifiable claim
    // must not become a permanent warning, which is the bug being fixed.
    expect(absoluteTtlShortened(ABS(86_400), ABS(3_600), undefined)).toBe(false);
  });

  it("ignores a nonsensical elapsed rather than trusting the arithmetic", () => {
    for (const bad of [-1, NaN, Infinity]) {
      expect(absoluteTtlShortened(ABS(86_400), ABS(60), bad)).toBe(false);
    }
  });

  it("says nothing about non-absolute TTLs, which are handled by the kind check", () => {
    expect(absoluteTtlShortened({ kind: "idle-peers", secs: 3_600 }, ABS(60), 10)).toBe(false);
    expect(absoluteTtlShortened(ABS(86_400), { kind: "idle-peers", secs: 60 }, 10)).toBe(false);
  });
});
