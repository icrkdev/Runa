// @vitest-environment jsdom
//
// Every action here used to be one of two things: wrap the selection, or
// insert a fixed block at column 1 and ignore the selection entirely. Three
// actions wanted neither. H2 wrote the literal words "## Heading" over what
// you had selected, and the code fence put an empty fence at the start of the
// line so its closing ``` ended up glued to the text already there — both
// reported from real use, both invisible to a test suite that never pressed
// the buttons.
import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { TOOLBAR_ACTIONS, applyTool, type ToolAction } from "./toolbar";

function harness(seed: string, sel: monaco.Range) {
  const model = monaco.editor.createModel(seed, "markdown");
  let caret: string | null = null;
  const editor = {
    getModel: () => model,
    getSelection: () => sel,
    executeEdits: (_s: string, edits: monaco.editor.IIdentifiedSingleEditOperation[]) =>
      model.applyEdits(edits as never),
    setPosition: (p: { lineNumber: number; column: number }) => {
      caret = `${p.lineNumber}:${p.column}`;
    },
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  return { model, editor, caretAt: () => caret };
}
const tool = (label: string): ToolAction => {
  const a = TOOLBAR_ACTIONS.find((t) => t.label === label);
  if (!a) throw new Error(`no toolbar action ${label}`);
  return a;
};

describe("toolbar actions respect the selection", () => {
  it("H2 makes the selected line a heading instead of writing the word Heading", () => {
    const h = harness("target\n", new monaco.Range(1, 1, 1, 7));
    applyTool(h.editor, tool("H2"));
    expect(h.model.getValue()).toBe("## target\n");
    expect(h.model.getValue()).not.toContain("Heading");
  });

  it("H2 prefixes every line of a multi-line selection", () => {
    const h = harness("one\ntwo\nthree\n", new monaco.Range(1, 1, 3, 6));
    applyTool(h.editor, tool("H2"));
    expect(h.model.getValue()).toBe("## one\n## two\n## three\n");
  });

  it("H2 leaves out a trailing line the selection only touches at column 1", () => {
    const h = harness("one\ntwo\nthree\n", new monaco.Range(1, 1, 3, 1));
    applyTool(h.editor, tool("H2"));
    expect(h.model.getValue()).toBe("## one\n## two\nthree\n");
  });

  it("the code fence encloses the selection rather than displacing it", () => {
    const h = harness("target\n", new monaco.Range(1, 1, 1, 7));
    applyTool(h.editor, tool("</>"));
    expect(h.model.getValue()).toContain("```\ntarget\n```");
    // The reported symptom: the closing fence welded to the line's own text.
    expect(h.model.getValue()).not.toContain("```target");
  });

  it("an empty code fence leaves the caret inside it", () => {
    const h = harness("target\n", new monaco.Range(1, 1, 1, 1));
    applyTool(h.editor, tool("</>"));
    expect(h.model.getValue()).toBe("```\n\n```\ntarget\n");
    expect(h.caretAt()).toBe("2:1");
  });

  it("display math encloses the selection too", () => {
    const h = harness("E = mc^2\n", new monaco.Range(1, 1, 1, 9));
    applyTool(h.editor, tool("∑"));
    expect(h.model.getValue()).toContain("$$\nE = mc^2\n$$");
  });

  it("the task list marks the selected line instead of inserting the word task", () => {
    const h = harness("target\n", new monaco.Range(1, 1, 1, 7));
    applyTool(h.editor, tool("☑"));
    expect(h.model.getValue()).toBe("- [ ] target\n");
    expect(h.model.getValue()).not.toContain("] task");
  });

  it("the table is a template, which is the honest behaviour for one", () => {
    const h = harness("target\n", new monaco.Range(1, 1, 1, 7));
    applyTool(h.editor, tool("▦"));
    expect(h.model.getValue()).toContain("| a | b |");
    expect(h.model.getValue()).toContain("target");
  });

  it.each([
    ["B", "**target**", 3],
    ["I", "*target*", 2],
    ["`", "`target`", 2],
    ["↗", "[target](https://)", 2],
  ])("%s wraps a selection, and parks the caret inside when there is none", (label, wrapped, col) => {
    const withSel = harness("target\n", new monaco.Range(1, 1, 1, 7));
    applyTool(withSel.editor, tool(label));
    expect(withSel.model.getValue()).toBe(`${wrapped}\n`);

    const empty = harness("target\n", new monaco.Range(1, 1, 1, 1));
    applyTool(empty.editor, tool(label));
    // Without this the caret lands past the closing marker and everything
    // typed next falls outside the emphasis it was meant to be inside.
    expect(empty.caretAt()).toBe(`1:${col}`);
  });

  it("every action is reachable and does something", () => {
    for (const a of TOOLBAR_ACTIONS) {
      const h = harness("target\n", new monaco.Range(1, 1, 1, 7));
      applyTool(h.editor, a);
      expect(h.model.getValue(), `${a.label} changed nothing`).not.toBe("target\n");
    }
  });
});
