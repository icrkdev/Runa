
export interface Binding {
  dispose(): void;
}

/// Translates a Yjs delta into Monaco edit operations using absolute
/// offsets resolved through `getPositionAt`, which correctly handles
/// multi-line deletions and insertions that cross newline boundaries.
/// Every range is computed against the pre-edit model state, which is what
/// `applyEdits` expects when edits are applied atomically.
export function deltaToEdits(
  event: { delta: ReadonlyArray<{ retain?: number; delete?: number; insert?: unknown }> },
  getPositionAt: (offset: number) => { lineNumber: number; column: number },
  monacoRange: (sl: number, sc: number, el: number, ec: number) => unknown,
): Array<{ range: unknown; text: string | null; forceMoveMarkers?: boolean }> {
  const edits: Array<{ range: unknown; text: string | null; forceMoveMarkers?: boolean }> = [];
  let index = 0;
  for (const d of event.delta) {
    if (d.retain != null) {
      index += d.retain;
    } else if (d.delete != null) {
      const start = getPositionAt(index);
      const end = getPositionAt(index + d.delete);
      edits.push({
        range: monacoRange(start.lineNumber, start.column, end.lineNumber, end.column),
        text: null,
      });
      // Deleted text occupies pre-edit positions: the cursor must advance.
      index += d.delete;
    } else if (d.insert != null && typeof d.insert === "string") {
      const pos = getPositionAt(index);
      edits.push({
        range: monacoRange(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: d.insert,
        forceMoveMarkers: true,
      });
      // Inserted text does not exist in the pre-edit model: no advance.
    }
  }
  return edits;
}

export function bindMonaco(
  monaco: typeof import("monaco-editor"),
  model: import("monaco-editor").editor.ITextModel,
  ydoc: import("yjs").Doc,
  text: import("yjs").Text,
): Binding {
  let applyingRemote = false;

  const onChange = model.onDidChangeContent((event) => {
    if (applyingRemote) return;
    ydoc.transact(() => {
      for (const change of event.changes) {
        if (change.rangeLength > 0) {
          text.delete(change.rangeOffset, change.rangeLength);
        }
        if (change.text.length > 0) {
          text.insert(change.rangeOffset, change.text);
        }
      }
    }, "local");
  });

  const observer = (event: import("yjs").YTextEvent, tr: import("yjs").Transaction): void => {
    if (tr.origin === "local") return;
    applyingRemote = true;
    try {
      const edits = deltaToEdits(
        { delta: event.delta },
        (offset) => model.getPositionAt(offset),
        (sl, sc, el, ec) =>
          new monaco.Range(sl, sc, el, ec),
      );
      if (edits.length > 0) {
        model.applyEdits(edits as Parameters<typeof model.applyEdits>[0]);
      }
    } finally {
      applyingRemote = false;
    }
  };

  text.observe(observer);

  return {
    dispose(): void {
      onChange.dispose();
      text.unobserve(observer);
    },
  };
}
