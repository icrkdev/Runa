// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { editor as MonacoEditor } from "monaco-editor";
import { clipboardReadAsksEveryTime, openBrowserMenuOnRightClick, standInText } from "./contextmenu";

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

describe("which browsers get their own menu", () => {
  it("is every WebKit and Gecko browser, which ask on each clipboard read; Blink asks once", () => {
    for (const ua of [SAFARI, FIREFOX, CHROME_IOS]) expect(clipboardReadAsksEveryTime(ua)).toBe(true);
    for (const ua of [CHROME, HEADLESS, EDGE]) expect(clipboardReadAsksEveryTime(ua)).toBe(false);
  });
});

/// Just enough of a Monaco editor: one document, one selection.
function fakeEditor(doc: string, sel: [number, number]) {
  const root = document.createElement("div");
  root.className = "monaco-editor";
  const lines = document.createElement("div");
  lines.className = "lines-content";
  const line = document.createElement("span");
  lines.appendChild(line);
  const scrollbar = document.createElement("div");
  scrollbar.className = "scrollbar";
  root.append(lines, scrollbar);
  document.body.appendChild(root);
  const range = (a: number, b: number) => ({ a, b, isEmpty: () => a === b });
  let selection = range(...sel);
  const calls: { trigger: unknown[][]; edits: unknown[]; focus: number } = { trigger: [], edits: [], focus: 0 };
  const editor = {
    getDomNode: () => root,
    getModel: () => ({
      getValueInRange: (r: { a: number; b: number }) => doc.slice(r.a, r.b),
      getEOL: () => "\n",
      getFullModelRange: () => range(0, doc.length),
    }),
    getSelections: () => [selection],
    setSelection: (r: { a: number; b: number }) => {
      selection = range(r.a, r.b);
    },
    focus: () => {
      calls.focus += 1;
    },
    trigger: (...args: unknown[]) => calls.trigger.push(args),
    executeEdits: (_source: string, edits: unknown[]) => calls.edits.push(...edits),
  };
  return { editor: editor as unknown as MonacoEditor.IStandaloneCodeEditor, line, scrollbar, calls, selection: () => selection };
}

const standIn = () => document.querySelector<HTMLTextAreaElement>("textarea.runa-menu-stand-in");

function rightClick(target: Element) {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2, clientX: 100, clientY: 80 }));
  // The browser aims the menu's event at whatever is under the pointer now.
  const under = standIn() ?? target;
  under.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 2 }));
}

function clipboardEvent(type: string, text = ""): { event: Event; written: () => string } {
  const store = new Map<string, string>([["text/plain", text]]);
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (t: string) => store.get(t) ?? "", setData: (t: string, v: string) => store.set(t, v) },
  });
  return { event, written: () => store.get("text/plain") ?? "" };
}

describe("right-click in Firefox and Safari", () => {
  let undo = () => {};
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    undo();
    vi.useRealTimers();
  });

  it("puts editable text under the pointer holding the selection, so the browser offers Cut, Copy and Paste", () => {
    const { editor, line } = fakeEditor("hello brave world", [6, 11]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(line);
    const el = standIn();
    expect(el).not.toBeNull();
    expect(document.activeElement).toBe(el);
    expect(el!.value.slice(el!.selectionStart, el!.selectionEnd)).toBe("brave");
  });

  it("does not stop the browser's menu from opening", () => {
    const { editor, line } = fakeEditor("abc", [0, 0]);
    undo = openBrowserMenuOnRightClick(editor);
    line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    standIn()!.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it("pastes what the browser's one Paste hands over into the editor, and gives it focus back", () => {
    const { editor, line, calls } = fakeEditor("abc", [1, 1]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(line);
    const { event } = clipboardEvent("paste", "pasted text");
    standIn()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(calls.trigger).toEqual([
      ["contextmenu", "paste", { text: "pasted text", pasteOnNewLine: false, multicursorText: null, mode: null }],
    ]);
    expect(calls.focus).toBe(1);
    expect(standIn()).toBeNull();
  });

  it("copies the editor's selection, not the stand-in's padding", () => {
    const { editor, line } = fakeEditor("hello brave world", [6, 11]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(line);
    const { event, written } = clipboardEvent("copy");
    standIn()!.dispatchEvent(event);
    expect(written()).toBe("brave");
  });

  it("cuts: copies the selection and deletes it from the editor", () => {
    const { editor, line, calls } = fakeEditor("hello brave world", [6, 11]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(line);
    const { event, written } = clipboardEvent("cut");
    standIn()!.dispatchEvent(event);
    expect(written()).toBe("brave");
    expect(calls.edits).toHaveLength(1);
    expect((calls.edits[0] as { text: string }).text).toBe("");
  });

  it("turns the browser's Select All into selecting the whole document", () => {
    const { editor, line, selection } = fakeEditor("hello brave world", [6, 11]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(line);
    const el = standIn()!;
    el.setSelectionRange(0, el.value.length);
    el.dispatchEvent(new Event("select"));
    expect(selection()).toMatchObject({ a: 0, b: 17 });
  });

  it("leaves nothing behind to catch clicks: not after the next press, and not after a press that never became a menu", () => {
    vi.useFakeTimers();
    const { editor, line } = fakeEditor("abc", [0, 0]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(line);
    expect(standIn()).not.toBeNull();
    line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(standIn()).toBeNull();

    line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    line.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 2 }));
    vi.advanceTimersByTime(400);
    expect(standIn()).toBeNull();
  });

  it("stays out of the way of the scrollbar and of left clicks", () => {
    const { editor, line, scrollbar } = fakeEditor("abc", [0, 0]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(scrollbar);
    expect(standIn()).toBeNull();
    line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(standIn()).toBeNull();
  });

  it("hands a key pressed after the menu was dismissed straight back to the editor", () => {
    const { editor, line, calls } = fakeEditor("abc", [0, 0]);
    undo = openBrowserMenuOnRightClick(editor);
    rightClick(line);
    standIn()!.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    expect(standIn()).toBeNull();
    expect(calls.focus).toBe(1);
  });

  it("is wrapped around the selection with one character either side", () => {
    expect(standInText("brave")).toEqual({ value: " brave ", start: 1, end: 6 });
    expect(standInText("")).toEqual({ value: "  ", start: 1, end: 1 });
  });
});
