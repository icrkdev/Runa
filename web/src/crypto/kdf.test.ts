import { describe, expect, it, vi } from "vitest";

// What a browser without WebAssembly, or without 64 MiB to give it, looks like
// from here.
vi.mock("hash-wasm", () => ({
  argon2id: () => Promise.reject(new Error("WebAssembly.instantiate(): Out of memory")),
}));

import { deriveFromPassphrase, KdfUnavailableError } from "./kdf";

describe("passphrase key derivation when Argon2id cannot run", () => {
  it("refuses, rather than quietly deriving a weaker key that no other browser can match", async () => {
    await expect(
      deriveFromPassphrase("harbor thistle quartz nine lantern", new Uint8Array(16).fill(4)),
    ).rejects.toBeInstanceOf(KdfUnavailableError);
  });
});
