import type { editor as MonacoEditor, IRange } from "monaco-editor";

/// Four kinds of action, because "insert a block of text at the start of the
/// line" was doing duty for all of them and got three of them wrong.
///
/// H2 wrote the literal words "## Heading" over whatever you had selected, and
/// the code fence inserted an empty fence at column 1 so the closing ``` ended
/// up glued to the line's existing text. Both reported from real use.
export interface ToolAction {
  label: string;
  title: string;
  /// Inline: wraps the selection. With nothing selected the caret is left
  /// between the markers rather than after them.
  wrap?: [string, string];
  /// Prefixes every selected line, keeping the text.
  linePrefix?: string;
  /// Block: puts the selection between two fence lines of its own.
  fence?: [string, string];
  /// Literal insert. The only honest option for something with no meaningful
  /// relationship to a selection.
  template?: string;
}

export const TOOLBAR_ACTIONS: ToolAction[] = [
  { label: "H2", title: "Heading", linePrefix: "## " },
  { label: "B", title: "Bold", wrap: ["**", "**"] },
  { label: "I", title: "Italic", wrap: ["*", "*"] },
  { label: "`", title: "Inline code", wrap: ["`", "`"] },
  { label: "</>", title: "Code fence", fence: ["```", "```"] },
  { label: "▦", title: "Table", template: "| a | b |\n|---|---|\n| 1 | 2 |\n" },
  { label: "∑", title: "Display math", fence: ["$$", "$$"] },
  { label: "☑", title: "Task list", linePrefix: "- [ ] " },
  { label: "↗", title: "Link", wrap: ["[", "](https://)"] },
];

const at = (line: number, column: number): IRange => ({
  startLineNumber: line,
  startColumn: column,
  endLineNumber: line,
  endColumn: column,
});

export function applyTool(
  editor: MonacoEditor.IStandaloneCodeEditor,
  action: ToolAction,
): void {
  const model = editor.getModel();
  if (!model) return;
  const selection = editor.getSelection();
  if (!selection) return;
  const selected = model.getValueInRange(selection);

  if (action.wrap) {
    const [before, after] = action.wrap;
    editor.executeEdits("runa-toolbar", [
      { range: selection, text: `${before}${selected}${after}`, forceMoveMarkers: true },
    ]);
    if (selected.length === 0) {
      // Otherwise the caret lands past the closing marker and everything
      // typed next falls outside the emphasis it was meant to be inside.
      editor.setPosition({
        lineNumber: selection.startLineNumber,
        column: selection.startColumn + before.length,
      });
    }
    return;
  }

  if (action.linePrefix) {
    // A selection that ends at column 1 does not include that last line; it
    // stops at its start, and prefixing it would mark a line the user did not
    // select.
    const last =
      selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
        ? selection.endLineNumber - 1
        : selection.endLineNumber;
    const edits = [];
    for (let line = selection.startLineNumber; line <= last; line++) {
      edits.push({ range: at(line, 1), text: action.linePrefix, forceMoveMarkers: true });
    }
    editor.executeEdits("runa-toolbar", edits);
    return;
  }

  if (action.fence) {
    const [open, close] = action.fence;
    const body = selected.length > 0 ? selected : "";
    editor.executeEdits("runa-toolbar", [
      { range: selection, text: `${open}\n${body}\n${close}\n`, forceMoveMarkers: true },
    ]);
    if (selected.length === 0) {
      // Land inside the fence, which is the only place anyone wants to be
      // after opening one.
      editor.setPosition({ lineNumber: selection.startLineNumber + 1, column: 1 });
    }
    return;
  }

  if (action.template) {
    editor.executeEdits("runa-toolbar", [
      { range: at(selection.startLineNumber, 1), text: action.template, forceMoveMarkers: true },
    ]);
  }
}
