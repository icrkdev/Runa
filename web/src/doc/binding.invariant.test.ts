// @vitest-environment jsdom
//
// The line-ending corruption that reached real users was not an exotic bug. It
// was an invariant nobody had written down — the Monaco model must hold
// character for character what the shared document holds — broken by a
// condition the test environment could not reach, since every model in
// headless Chromium on macOS uses LF.
//
// This file sweeps that same invariant across the other places the two
// coordinate spaces could drift: surrogate pairs, combining marks, tabs,
// multi-range edits, interleaved remote deltas, pastes larger than the
// coalescing buffer, and undo across a remote edit.
//
// Every case asserts `binding.repairs === 0` as well as equality. Equality
// alone would prove nothing: the reconciliation net rebuilds the model from
// the document whenever they disagree, so a broken path would still finish
// equal. The counter is what separates "correct" from "quietly repaired", and
// the meta-check at the end forces a desync to prove the harness can fail.
import { expect, test } from "vitest";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import * as Y from "yjs";
import { bindMonaco } from "./binding";

function bound(seed: string, opts?: Record<string, unknown>) {
  const model = monaco.editor.createModel(seed, "markdown");
  if (opts) model.updateOptions(opts as never);
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");
  text.insert(0, seed);
  const binding = bindMonaco(monaco, model, ydoc, text);
  return { model, ydoc, text, binding };
}
function remote(ydoc: Y.Doc, fn: (t: Y.Text) => void) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
  fn(other.getText("content"));
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(ydoc)), "remote");
}
const results: string[] = [];
function probe(name: string, fn: () => { model: { getValue(): string }; text: Y.Text; binding: { repairs: number } }) {
  try {
    const { model, text, binding } = fn();
    // Equality alone proves nothing now: the reconciliation net would have
    // produced it. A path is only correct if it never needed repairing.
    const ok = model.getValue() === text.toString() && binding.repairs === 0;
    results.push(`${ok ? "  ok  " : "*FAIL*"} ${name}${binding.repairs ? ` (repaired ${binding.repairs}x — path is wrong, net hid it)` : ""}`);
    if (!ok) {
      results.push(`         model: ${JSON.stringify(model.getValue()).slice(0, 110)}`);
      results.push(`         ytext: ${JSON.stringify(text.toString()).slice(0, 110)}`);
    }
  } catch (e) {
    results.push(`*ERR * ${name}: ${(e as Error).message.slice(0, 90)}`);
  }
}
const at = (m: monaco.editor.ITextModel, offset: number) => {
  const p = m.getPositionAt(offset);
  return new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column);
};

test("invariant sweep: model must equal the shared document", () => {
  probe("emoji typed locally", () => {
    const b = bound("start\n");
    b.model.applyEdits([{ range: at(b.model, 6), text: "🙂 café 👨‍👩‍👧" }]);
    return b;
  });
  probe("emoji arriving remotely, then a local edit before it", () => {
    const b = bound("start\n");
    remote(b.ydoc, (t) => t.insert(t.length, "🙂🙂🙂 tail"));
    b.model.applyEdits([{ range: at(b.model, 0), text: "PRE" }]);
    return b;
  });
  probe("combining characters", () => {
    const b = bound("a\n");
    remote(b.ydoc, (t) => t.insert(t.length, "é́ x"));
    b.model.applyEdits([{ range: at(b.model, 1), text: "Z" }]);
    return b;
  });
  probe("tab with insertSpaces", () => {
    const b = bound("line\n", { insertSpaces: true, tabSize: 2 });
    b.model.applyEdits([{ range: at(b.model, 5), text: "\tindented" }]);
    return b;
  });
  probe("multi-range single edit (replace-all shape)", () => {
    const b = bound("foo bar foo bar foo\n");
    const v = b.model.getValue();
    const ranges: monaco.Range[] = [];
    let i = v.indexOf("foo");
    while (i !== -1) {
      const s = b.model.getPositionAt(i);
      const e = b.model.getPositionAt(i + 3);
      ranges.push(new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column));
      i = v.indexOf("foo", i + 3);
    }
    b.model.applyEdits(ranges.map((r) => ({ range: r, text: "QUUX" })));
    return b;
  });
  probe("remote delta interleaving insert and delete", () => {
    const b = bound("abcdefghij\n");
    remote(b.ydoc, (t) => { t.delete(2, 3); t.insert(2, "XY"); t.delete(6, 2); t.insert(0, "Z"); });
    return b;
  });
  probe("large paste beyond the coalescing buffer", () => {
    const b = bound("");
    b.model.applyEdits([{ range: at(b.model, 0), text: "x".repeat(40_000) + "\n" + "y".repeat(40_000) }]);
    return b;
  });
  // The shape undo produces: a local edit, a remote edit landing on top of it,
  // then the inverse of the local edit applied against shifted offsets.
  probe("inverse of a local edit after a remote edit lands", () => {
    const b = bound("base\n");
    b.model.applyEdits([{ range: at(b.model, 5), text: "local" }]);
    remote(b.ydoc, (t) => t.insert(0, "REMOTE "));
    const start = b.model.getValue().indexOf("local");
    const s0 = b.model.getPositionAt(start);
    const s1 = b.model.getPositionAt(start + "local".length);
    b.model.applyEdits([
      { range: new monaco.Range(s0.lineNumber, s0.column, s1.lineNumber, s1.column), text: "" },
    ]);
    return b;
  });
  probe("remote delete spanning a newline", () => {
    const b = bound("one\ntwo\nthree\n");
    remote(b.ydoc, (t) => t.delete(2, 6));
    return b;
  });
  probe("local edit at position 0 while remote appends", () => {
    const b = bound("mid\n");
    remote(b.ydoc, (t) => t.insert(t.length, "after\n"));
    b.model.applyEdits([{ range: at(b.model, 0), text: "before-" }]);
    return b;
  });
  // Meta-check: a harness that cannot fail proves nothing. Force the model
  // back to CRLF behind the binding's back — the exact condition that caused
  // the field corruption — and the net must notice and repair it.
  {
    const b = bound("one\ntwo\n");
    b.model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    remote(b.ydoc, (t) => t.insert(t.length, "three\n"));
    const detected = b.binding.repairs > 0 && b.model.getValue() === b.text.toString();
    results.push(
      `${detected ? "  ok  " : "*FAIL*"} meta: net detects and repairs a forced CRLF model (repairs=${b.binding.repairs})`,
    );
  }
  console.log("\n──── binding invariant sweep ────\n" + results.join("\n") + "\n");
  expect(results.filter((r) => r.startsWith("*"))).toEqual([]);
});
