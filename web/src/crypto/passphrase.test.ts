import { describe, expect, it } from "vitest";
import { estimatePassphrase } from "./passphrase";
import { generateDicewarePassphrase } from "./fingerprint";
import { deriveFromPassphrase } from "./kdf";

describe("passphrase strength floor (spec §3.9.2)", () => {
  it("accepts a generated four-word diceware phrase (~44 bits)", () => {
    for (let i = 0; i < 10; i++) {
      const v = estimatePassphrase(generateDicewarePassphrase(4));
      expect(v.ok).toBe(true);
      expect(v.bits).toBeGreaterThanOrEqual(40);
      expect(v.dicewareWords).toBe(4);
    }
  });

  it("refuses common weak passphrases outright", () => {
    for (const p of ["password", "123456789012", "correct horse", "abc", ""]) {
      expect(estimatePassphrase(p).ok).toBe(false);
    }
  });

  it("accepts long mixed-charset phrases", () => {
    const v = estimatePassphrase("correct-horse-battery-staple-42!");
    expect(v.ok).toBe(true);
  });

  it("three diceware words still clear the floor (33+ bits? no: 33 bits refuses)", () => {
    const three = estimatePassphrase("harbor thistle quartz");
    expect(three.dicewareWords).toBe(3);
    expect(three.ok).toBe(false);
  });
});

describe("KDF integration", () => {
  it("same passphrase and salt give the same material; different salt does not", async () => {
    const s1 = new Uint8Array(16).fill(1);
    const s2 = new Uint8Array(16).fill(2);
    const small = { mKib: 8192 };
    const a = await deriveFromPassphrase("test phrase", s1, small);
    const b = await deriveFromPassphrase("test phrase", s1, small);
    const c = await deriveFromPassphrase("test phrase", s2, small);
    const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(a.material)).toBe(hex(b.material));
    expect(hex(a.material)).not.toBe(hex(c.material));
  });
});
