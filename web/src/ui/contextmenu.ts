import { MenuId, MenuRegistry } from "monaco-editor/esm/vs/platform/actions/common/actions.js";

const PASTE_COMMAND = "editor.action.clipboardPasteAction";

/// Whether a script reading the clipboard makes the browser ask first, every
/// time.
///
/// A page cannot paste on its own; Monaco's Paste item has to ask for the
/// clipboard with `navigator.clipboard.readText()`. Safari, and Firefox since
/// 125, answer that by putting their own "Paste" button under the pointer and
/// waiting for a second click — which is the second Paste in the reports, and
/// why no preventDefault ever removed it: it is not a menu. Pages cannot turn
/// it off. Chromium asks once per site and remembers the answer.
///
/// Every browser on iOS is WebKit, whatever its name, so the test is for Blink
/// rather than against Safari. Chromium's user agent says `Chrome/` (headless
/// says `HeadlessChrome/`); Chrome on iOS says `CriOS/` and is WebKit.
export function clipboardReadAsksEveryTime(userAgent: string): boolean {
  return !/Chrom(?:e|ium)\//.test(userAgent);
}

/// Drop Paste from the editor's right-click menu where it could only ever take
/// two clicks, and leave the rest of the menu alone.
///
/// Keyboard paste is unaffected everywhere: it is the browser's own paste
/// event, which asks nothing. Monaco has no option for a single menu item, so
/// this filters what its menu registry hands the context menu; the e2e suite
/// reads the rendered menu in each engine, so a Monaco upgrade that moves the
/// registry fails there rather than quietly bringing the button back.
///
/// Returns the undo, for tests. Installing twice is harmless.
export function keepPasteOffTheMenuWhereItAsksTwice(userAgent: string = navigator.userAgent): () => void {
  if (!clipboardReadAsksEveryTime(userAgent)) return () => {};
  const registry = MenuRegistry;
  const original = registry.getMenuItems;
  registry.getMenuItems = function (id) {
    const items = original.call(this, id);
    if (id !== MenuId.EditorContext) return items;
    return items.filter((item) => !("command" in item && item.command.id === PASTE_COMMAND));
  };
  return () => {
    registry.getMenuItems = original;
  };
}
