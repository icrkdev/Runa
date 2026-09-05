// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module remembers that the warning was accepted, so each test loads a
// fresh copy. Without this the "declined" case runs after a successful export,
// finds the flag already set, exports without asking, and fails for a reason
// that has nothing to do with what it is checking.
async function fresh() {
  vi.resetModules();
  return import("./markdown");
}

let captured: Blob | null;
beforeEach(() => {
  captured = null;
  // jsdom implements neither of these.
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn((b: Blob) => {
    captured = b;
    return "blob:test";
  });
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("markdown export", () => {
  it("names files by timestamp and never by room", async () => {
    const { markdownFilename } = await fresh();
    const name = markdownFilename(new Date(2026, 8, 4, 7, 5));
    expect(name).toBe("runa-20260904-0705.md");
    // A downloaded file outlives the room and lands where RÚNA has no reach.
    // Naming it after the room would write that address into a downloads
    // folder, a backup, and whatever syncs them.
    expect(name).not.toMatch(/[0-9a-f]{16}/);
  });

  it("pads every field so names sort chronologically", async () => {
    const { markdownFilename } = await fresh();
    expect(markdownFilename(new Date(2026, 0, 2, 3, 4))).toBe("runa-20260102-0304.md");
  });

  it("writes the source verbatim, not the rendered preview", async () => {
    const { exportMarkdown } = await fresh();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const src = "# Heading\n\n$$E = mc^2$$\n\n- [ ] task\n";
    expect(exportMarkdown(src)).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("text/markdown;charset=utf-8");
    // jsdom's Blob has no .text(); FileReader is what it does implement.
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(captured!);
    });
    expect(text).toBe(src);
  });

  it("warns once, then stops asking for the rest of the session", async () => {
    const { exportMarkdown } = await fresh();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    exportMarkdown("one");
    exportMarkdown("two");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for an empty document", async () => {
    const { exportMarkdown } = await fresh();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(exportMarkdown("")).toBe(false);
    // Not even asked: there is nothing to warn about.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("writes nothing when the warning is declined", async () => {
    const { exportMarkdown } = await fresh();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(exportMarkdown("something")).toBe(false);
    expect(captured).toBeNull();
  });
});
