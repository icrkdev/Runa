// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import * as Y from "yjs";
import { bindMonaco } from "./binding";

/// The invariant the binding lives or dies by: the Monaco model must hold
/// exactly what the shared document holds. Every field-reported corruption —
/// text landing one character right on other machines, a delete that never
/// propagated, two lines merged on one client only — is this invariant broken
/// by Monaco rewriting inserted text to the model's own end-of-line sequence.
function bound(seed: string) {
  const model = monaco.editor.createModel(seed, "markdown");
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, seed);
  const binding = bindMonaco(monaco, model, ydoc, text);
  return { model, ydoc, text, binding };
}

function remoteInsert(ydoc: Y.Doc, at: number, s: string) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
  other.getText("content").insert(at, s);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(ydoc)), "remote");
}

describe("model and shared document stay character-identical", () => {
  it("pins the model to LF even when seeded from CRLF", () => {
    const { model } = bound("alpha\r\nbravo");
    expect(model.getEOL()).toBe("\n");
  });

  it("strips carriage returns a previous client left in the document", () => {
    const { model, text } = bound("alpha\r\nbravo");
    expect(text.toString()).toBe("alpha\nbravo");
    expect(model.getValue()).toBe(text.toString());
  });

  it("survives a remote newline insert, which used to desync by one per line", () => {
    const { model, ydoc, text } = bound("alpha\r\nbravo");
    remoteInsert(ydoc, text.length, "\ncharlie");
    expect(model.getValue()).toBe(text.toString());
  });

  it("keeps local edits addressing the right place after remote newlines", () => {
    const { model, ydoc, text } = bound("alpha\r\nbravo");
    remoteInsert(ydoc, text.length, "\ncharlie\ndelta");
    // Type in the middle, which is where a stale offset does visible damage.
    const pos = model.getPositionAt(model.getValue().indexOf("charlie"));
    model.applyEdits([{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: "X" }]);
    expect(model.getValue()).toBe(text.toString());
    expect(text.toString()).toContain("Xcharlie");
  });

  it("holds through interleaved local and remote edits", () => {
    const { model, ydoc, text } = bound("one\r\ntwo\r\nthree");
    for (let i = 0; i < 6; i++) {
      remoteInsert(ydoc, Math.min(4, text.length), `r${i}\n`);
      const end = model.getFullModelRange().getEndPosition();
      model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: `l${i}\n` }]);
      expect(model.getValue()).toBe(text.toString());
    }
  });
});
