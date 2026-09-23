import { describe, expect, it } from "vitest";
import { LogCursor } from "./cursor";

describe("LogCursor", () => {
  it("advances only over a contiguous run, whatever order entries arrive in", () => {
    const c = new LogCursor();
    c.note(1);
    c.note(2);
    expect(c.watermark).toBe(0);
    c.note(0);
    expect(c.watermark).toBe(3);
    c.note(5);
    expect(c.watermark).toBe(3);
    c.note(3);
    c.note(4);
    expect(c.watermark).toBe(6);
  });

  it("jumps to a snapshot's cover and keeps what it already had above it", () => {
    const c = new LogCursor();
    c.note(12);
    c.note(10);
    c.noteBelow(10);
    expect(c.watermark).toBe(11);
    c.note(11);
    expect(c.watermark).toBe(13);
  });

  it("never moves backwards, and ignores what is not an index", () => {
    const c = new LogCursor();
    c.noteBelow(8);
    c.noteBelow(3);
    c.note(2);
    c.note(-1);
    c.note(Number.NaN);
    c.note(1.5);
    expect(c.watermark).toBe(8);
  });

  it("counts from zero again for a new log", () => {
    const c = new LogCursor();
    c.noteBelow(40);
    c.note(41);
    c.reset();
    expect(c.watermark).toBe(0);
    c.note(0);
    expect(c.watermark).toBe(1);
  });
});
