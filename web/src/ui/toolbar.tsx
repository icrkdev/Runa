import type { editor as MonacoEditor } from "monaco-editor";

export interface ToolAction {
  label: string;
  title: string;
  wrap?: [string, string];
  block?: string;
}

export const TOOLBAR_ACTIONS: ToolAction[] = [
  { label: "H2", title: "Heading", block: "## Heading\n" },
  { label: "B", title: "Bold", wrap: ["**", "**"] },
  { label: "I", title: "Italic", wrap: ["*", "*"] },
  { label: "`", title: "Inline code", wrap: ["`", "`"] },
  { label: "</>", title: "Code fence", block: "```\n\n```" },
  { label: "▦", title: "Table", block: "| a | b |\n|---|---|\n| 1 | 2 |\n" },
  { label: "∑", title: "Display math", block: "$$\nE = mc^2\n$$\n" },
  { label: "☑", title: "Task list", block: "- [ ] task\n" },
  { label: "↗", title: "Link", wrap: ["[", "](https://)"] },
];

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
      {
        range: selection,
        text: `${before}${selected}${after}`,
        forceMoveMarkers: true,
      },
    ]);
    return;
  }
  if (action.block) {
    const pos = model.getPositionAt(model.getOffsetAt(selection.getStartPosition()));
    const lineStart = selection.startLineNumber;
    editor.executeEdits("runa-toolbar", [
      {
        range: {
          startLineNumber: lineStart,
          startColumn: 1,
          endLineNumber: lineStart,
          endColumn: 1,
        },
        text: action.block,
        forceMoveMarkers: true,
      },
    ]);
    void pos;
  }
}
