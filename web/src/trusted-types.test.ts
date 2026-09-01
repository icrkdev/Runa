import { describe, expect, it, beforeAll } from "vitest";
import { assertSameOriginScriptUrl } from "./trusted-types";

beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = {
    location: { href: "https://runa.example/r/abc", origin: "https://runa.example" },
  };
});

describe("trusted types script-url policy", () => {
  it("allows the same-origin worker URLs Monaco needs", () => {
    expect(assertSameOriginScriptUrl("https://runa.example/assets/editor.worker.js"))
      .toContain("editor.worker.js");
    expect(assertSameOriginScriptUrl("/assets/editor.worker.js")).toBe("/assets/editor.worker.js");
    const blob = "blob:https://runa.example/2f8c-11ee";
    expect(assertSameOriginScriptUrl(blob)).toBe(blob);
    // A bare relative path is same-origin by definition.
    expect(assertSameOriginScriptUrl("worker.js")).toBe("worker.js");
  });

  it("refuses anything that is not this origin", () => {
    for (const bad of [
      "https://evil.example/x.js",
      "//evil.example/x.js",
      "blob:https://evil.example/2f8c",
      "data:text/javascript,alert(1)",
      "javascript:alert(1)",
      "blob:https://runa.example.evil.com/2f8c",
    ]) {
      expect(() => assertSameOriginScriptUrl(bad)).toThrow();
    }
  });
});
