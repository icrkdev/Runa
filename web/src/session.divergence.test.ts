import { describe, expect, it } from "vitest";
import { divergenceAction } from "./session";

const at = (o: Partial<Parameters<typeof divergenceAction>[0]> = {}) =>
  divergenceAction({
    diverged: true,
    reported: false,
    repairAttemptedAt: 0,
    now: 100_000,
    settleMs: 15_000,
    ...o,
  });

describe("a disagreement is repaired before it is announced", () => {
  it("repairs first rather than warning first", () => {
    // The warning used to be the whole response: it appeared, sat there, and
    // the only thing that actually fixed a stale copy was reloading the page.
    expect(at()).toBe("repair");
  });

  it("says nothing while the repair is still in flight", () => {
    expect(at({ repairAttemptedAt: 95_000 })).toBe("none");
  });

  it("warns once the repair has had its chance and failed", () => {
    expect(at({ repairAttemptedAt: 80_000 })).toBe("warn");
  });

  it("does not warn twice", () => {
    expect(at({ repairAttemptedAt: 80_000, reported: true })).toBe("none");
  });

  it("clears the warning when the copies agree again", () => {
    expect(at({ diverged: false, reported: true })).toBe("clear");
  });

  it("stays quiet when there was nothing wrong to begin with", () => {
    expect(at({ diverged: false, reported: false })).toBe("none");
  });

  it("repairs again after a disagreement returns", () => {
    // "clear" resets the attempt marker, so a later disagreement gets its own
    // repair rather than going straight to a warning.
    expect(at({ repairAttemptedAt: 0, reported: false })).toBe("repair");
  });

  it("never warns without having tried a repair", () => {
    // The whole point: a warning means the relay could not fix it, so a path
    // that warns while repairAttemptedAt is still zero would be lying.
    for (const now of [0, 1_000, 100_000, 10_000_000]) {
      expect(at({ now, repairAttemptedAt: 0 })).not.toBe("warn");
    }
  });

  it("does not sit silent for ever if the settle window is misconfigured", () => {
    expect(at({ repairAttemptedAt: 1, now: 10_000_000 })).toBe("warn");
  });
});
