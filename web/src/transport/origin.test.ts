import { describe, expect, it } from "vitest";
import { plainWebSocketAllowed } from "./origin";

const ONION = `${"a".repeat(52)}2345.onion`;

describe("when a plain ws:// socket is allowed", () => {
  it("on loopback and on a v3 onion service", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "dev.localhost", ONION]) {
      expect(plainWebSocketAllowed({ protocol: "http:", hostname }), hostname).toBe(true);
    }
  });

  it("never on an ordinary public http:// page", () => {
    for (const hostname of ["runa.example.com", "203.0.113.9", "onion.example.com", "evil.onion.example.com"]) {
      expect(plainWebSocketAllowed({ protocol: "http:", hostname }), hostname).toBe(false);
    }
  });

  it("not for a name that only looks like an onion", () => {
    for (const hostname of ["short.onion", `${"a".repeat(56)}.onion.example.com`, `${"A".repeat(56)}.onion`]) {
      expect(plainWebSocketAllowed({ protocol: "http:", hostname }), hostname).toBe(false);
    }
  });

  it("not over https:, which uses wss://", () => {
    expect(plainWebSocketAllowed({ protocol: "https:", hostname: ONION })).toBe(false);
  });
});
