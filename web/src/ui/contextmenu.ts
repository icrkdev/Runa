import type { editor as MonacoEditor } from "monaco-editor";

/// Whether a script reading the clipboard makes the browser ask first, every
/// time.
///
/// A page cannot paste on its own; Monaco's Paste item has to ask for the
/// clipboard with `navigator.clipboard.readText()`. Safari, and Firefox since
/// 125, answer that by putting their own "Paste" button under the pointer and
/// waiting for a second click — the second Paste in the reports. It is a
/// permission prompt, not a menu, and pages cannot turn it off. Chromium asks
/// once per site and remembers the answer.
///
/// Every browser on iOS is WebKit, whatever its name, so the test is for Blink
/// rather than against Safari. Chromium's user agent says `Chrome/` (headless
/// says `HeadlessChrome/`); Chrome on iOS says `CriOS/` and is WebKit.
export function clipboardReadAsksEveryTime(userAgent: string): boolean {
  return !/Chrom(?:e|ium)\//.test(userAgent);
}

/// What the stand-in holds: the editor's selection with one space either side,
/// the selection itself selected. The spaces are what let "Select All" be
/// told apart from the selection it started with.
export function standInText(selected: string): { value: string; start: number; end: number } {
  return { value: ` ${selected} `, start: 1, end: 1 + selected.length };
}

/// Right-click in the editor opens the browser's own menu, whose Paste is one
/// click, instead of Monaco's, whose Paste can only ever be two here.
///
/// The browser's menu only offers Cut, Copy and Paste over something editable,
/// and what is under the pointer in Monaco is a stack of divs — its real input
/// is a hidden textarea somewhere else. So on the press that opens the menu, a
/// transparent textarea is put under the pointer holding the editor's current
/// selection, selected. The browser sees editable text with a selection and
/// offers the full menu; whichever item is chosen arrives as an ordinary cut,
/// copy, paste or select event on the stand-in, and is carried out on the
/// editor from there. Nothing is read from the clipboard by script, so nothing
/// asks.
///
/// Monaco's own menu is never reached: the menu's event goes to the stand-in,
/// which is not inside the editor. Returns the undo.
export function openBrowserMenuOnRightClick(
  editor: MonacoEditor.IStandaloneCodeEditor,
  doc: Document = document,
): () => void {
  const win = doc.defaultView ?? window;
  const root = editor.getDomNode();
  if (!root) return () => {};
  let standIn: HTMLTextAreaElement | null = null;
  let startedWith = { start: 0, end: 0 };
  let passThrough: ReturnType<typeof setTimeout> | null = null;
  /// Whether the menu's own event has reached the stand-in yet.
  let armed = false;

  const remove = (refocus: boolean): void => {
    if (passThrough) clearTimeout(passThrough);
    passThrough = null;
    const el = standIn;
    standIn = null;
    armed = false;
    if (!el) return;
    el.remove();
    if (refocus) editor.focus();
  };

  const selectedText = (): string => {
    const model = editor.getModel();
    if (!model) return "";
    return editor
      .getSelections()
      ?.filter((s) => !s.isEmpty())
      .map((s) => model.getValueInRange(s))
      .join(model.getEOL()) ?? "";
  };

  const place = (x: number, y: number): HTMLTextAreaElement => {
    remove(false);
    const el = doc.createElement("textarea");
    el.className = "runa-menu-stand-in";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.spellcheck = false;
    const s = el.style;
    s.position = "fixed";
    s.left = `${x - 20}px`;
    s.top = `${y - 20}px`;
    s.width = "40px";
    s.height = "40px";
    s.margin = "0";
    s.padding = "0";
    s.border = "0";
    s.outline = "none";
    s.resize = "none";
    s.overflow = "hidden";
    s.opacity = "0";
    s.zIndex = "2147483647";
    s.fontSize = "16px";
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      remove(true);
      if (text) editor.trigger("contextmenu", "paste", { text, pasteOnNewLine: false, multicursorText: null, mode: null });
    });
    el.addEventListener("copy", (e) => {
      e.preventDefault();
      e.clipboardData?.setData("text/plain", selectedText());
      remove(true);
    });
    el.addEventListener("cut", (e) => {
      e.preventDefault();
      e.clipboardData?.setData("text/plain", selectedText());
      remove(true);
      const selections = editor.getSelections() ?? [];
      editor.executeEdits(
        "contextmenu",
        selections.filter((s) => !s.isEmpty()).map((range) => ({ range, text: "" })),
      );
    });
    el.addEventListener("select", () => {
      if (el.selectionStart === 0 && el.selectionEnd === el.value.length &&
          (startedWith.start !== 0 || startedWith.end !== el.value.length)) {
        const model = editor.getModel();
        remove(true);
        if (model) editor.setSelection(model.getFullModelRange());
      }
    });
    // Dismissed with Escape, the menu leaves focus here. Hand it back before
    // the key does anything, so what was typed lands in the editor.
    el.addEventListener("keydown", () => remove(true));
    doc.body.appendChild(el);
    return el;
  };

  const opensMenu = (e: MouseEvent): boolean =>
    e.button === 2 || (e.button === 0 && e.ctrlKey && /Mac/.test(win.navigator.platform));

  const inText = (target: EventTarget | null): boolean => {
    const el = target instanceof Element ? target : null;
    return !!el && root.contains(el) && !!el.closest(".lines-content, .margin");
  };

  const onMouseDown = (e: MouseEvent): void => {
    // Any press ends a stand-in left over from the last menu. The press that
    // follows a dismissed menu focuses whatever it lands on by itself.
    if (standIn) remove(false);
    if (!opensMenu(e) || !inText(e.target)) return;
    // Placed now, so that it is under the pointer by the time the menu's own
    // event looks: on the press on macOS and Linux, on the release on
    // Windows. Monaco still receives this press, and still decides whether a
    // right-click moves the caret, before the stand-in is filled.
    standIn = place(e.clientX, e.clientY);
  };

  // A press that never became a menu — dragged off, or swallowed by the
  // system — must not leave an invisible box behind catching clicks.
  const onMouseUp = (): void => {
    const el = standIn;
    if (!el || armed) return;
    setTimeout(() => {
      if (standIn === el && !armed) remove(false);
    }, 300);
  };

  const onContextMenu = (e: MouseEvent): void => {
    const el = standIn;
    if (!el || e.target !== el) return;
    armed = true;
    const { value, start, end } = standInText(selectedText());
    el.value = value;
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    startedWith = { start, end };
    // Once the menu is up it acts on what has focus, not on what is under
    // the pointer, so the stand-in stops catching clicks at once.
    passThrough = setTimeout(() => {
      if (standIn === el) el.style.pointerEvents = "none";
    }, 0);
  };

  win.addEventListener("mousedown", onMouseDown, true);
  win.addEventListener("mouseup", onMouseUp, true);
  win.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    win.removeEventListener("mousedown", onMouseDown, true);
    win.removeEventListener("mouseup", onMouseUp, true);
    win.removeEventListener("contextmenu", onContextMenu, true);
    remove(false);
  };
}
