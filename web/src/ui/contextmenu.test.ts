// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { MenuId, MenuRegistry } from "monaco-editor/esm/vs/platform/actions/common/actions.js";
import { clipboardReadAsksEveryTime, keepPasteOffTheMenuWhereItAsksTwice } from "./contextmenu";

// Monaco registers Cut, Copy and Paste only where the document says it supports
// them, and jsdom has no queryCommandSupported at all.
Object.assign(document, { queryCommandSupported: () => true });
await import("monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js");

const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const HEADLESS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36";
const EDGE = `${CHROME} Edg/151.0.0.0`;

function contextCommands(): string[] {
  return MenuRegistry.getMenuItems(MenuId.EditorContext).flatMap((i) => ("command" in i ? [i.command.id] : []));
}

describe("the editor's right-click Paste", () => {
  let undo = () => {};
  afterEach(() => undo());

  it("is registered by Monaco to begin with, or the filter below tests nothing", () => {
    expect(contextCommands()).toContain("editor.action.clipboardPasteAction");
  });

  it("is judged by engine: every WebKit and Gecko browser asks on each read, Blink does not", () => {
    for (const ua of [SAFARI, FIREFOX, CHROME_IOS]) expect(clipboardReadAsksEveryTime(ua)).toBe(true);
    for (const ua of [CHROME, HEADLESS, EDGE]) expect(clipboardReadAsksEveryTime(ua)).toBe(false);
  });

  it.each([
    ["Safari", SAFARI],
    ["Firefox", FIREFOX],
    ["Chrome on iOS", CHROME_IOS],
  ])("leaves %s's menu, minus Paste", (_name, ua) => {
    const before = contextCommands();
    undo = keepPasteOffTheMenuWhereItAsksTwice(ua);
    const after = contextCommands();
    expect(after).not.toContain("editor.action.clipboardPasteAction");
    expect(after).toEqual(before.filter((id) => id !== "editor.action.clipboardPasteAction"));
  });

  it("stays in Chromium, which asks once per site", () => {
    const before = contextCommands();
    undo = keepPasteOffTheMenuWhereItAsksTwice(CHROME);
    expect(contextCommands()).toEqual(before);
  });
});
