
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

/// Monaco stores one end-of-line sequence for the whole model and rewrites
/// every inserted string to match it. Y.Text stores exactly the characters it
/// is handed. When those disagree the two drift apart silently: a model using
/// CRLF that receives a remote "\ncharlie" gains 21 characters where the
/// shared document gained 20, and from then on every `change.rangeOffset` —
/// a *model* offset — addresses the wrong place in Y.Text. The error grows by
/// one per newline and never heals.
///
/// Field-reported symptoms of exactly that skew: text landing one character
/// to the right on other machines, a deletion that took locally and never
/// propagated, and two lines appearing merged on one client while separate
/// everywhere else.
const LF_ONLY = (s: string): string => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export function bindMonaco(
  monaco: typeof import("monaco-editor"),
  model: import("monaco-editor").editor.ITextModel,
  ydoc: import("yjs").Doc,
  text: import("yjs").Text,
): Binding {
  let applyingRemote = false;

  // One EOL for every client, so Monaco's normalisation is a no-op and model
  // offsets keep meaning the same thing as Y.Text offsets.
  model.setEOL(monaco.editor.EndOfLineSequence.LF);

  // A document written by a client from before this fix can already contain
  // CRLF, which an LF model can never equal. Strip the carriage returns in the
  // shared document itself, back to front so the offsets stay valid while
  // deleting. Every peer computes the same result, so this converges instead
  // of fighting.
  const existing = text.toString();
  if (existing !== LF_ONLY(existing)) {
    ydoc.transact(() => {
      for (let i = existing.length - 1; i >= 0; i--) {
        if (existing[i] === "\r") text.delete(i, 1);
      }
    }, "local");
  }

  /// The model is a view of the shared document. If they ever disagree the
  /// shared document wins — silent corruption is far worse than a lost undo
  /// stack, and this should never fire now that the EOL is pinned.
  const reconcile = (): void => {
    if (applyingRemote) return;
    const truth = text.toString();
    if (model.getValue() === truth) return;
    applyingRemote = true;
    try {
      model.setValue(truth);
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
    } finally {
      applyingRemote = false;
    }
  };

  const onChange = model.onDidChangeContent((event) => {
    if (applyingRemote) return;
    ydoc.transact(() => {
      for (const change of event.changes) {
        if (change.rangeLength > 0) {
          text.delete(change.rangeOffset, change.rangeLength);
        }
        if (change.text.length > 0) {
          // Defensive: with the EOL pinned Monaco already reports LF, but a
          // stray carriage return must never reach the shared document.
          text.insert(change.rangeOffset, LF_ONLY(change.text));
        }
      }
    }, "local");
    reconcile();
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
    reconcile();
  };

  text.observe(observer);

  return {
    dispose(): void {
      onChange.dispose();
      text.unobserve(observer);
    },
  };
}
