import { useEffect, type RefObject } from "react";

interface Anchors {
  el: HTMLElement;
  line: number;
}

function collectAnchors(root: HTMLElement | null): Anchors[] {
  if (!root) return [];
  const out: Anchors[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-src-line]"))) {
    const line = Number(el.getAttribute("data-src-line"));
    if (Number.isFinite(line)) out.push({ el, line });
  }
  return out;
}

/// Direction lock with a timestamp so programmatic scrolls don't feed back
/// into the other pane. The lock decays after 120 ms, which is long enough
/// for the browser to dispatch the scroll event and short enough not to
/// fight the user.
export function useLineSync(
  editorRef: RefObject<{
    scrollTop(line: number): void;
    getTopVisibleLine(): number;
    onScroll(fn: () => void): () => void;
  } | null>,
  previewRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    let lastEditorDrive = 0;
    let raf = 0;

    const editorToPreview = () => {
      const ed = editorRef.current;
      const preview = previewRef.current;
      if (!ed || !preview) return;
      // Skip if the preview drove us recently
      if (Date.now() - lastEditorDrive < 120 && Date.now() - lastEditorDrive >= 0) return;
      const anchors = collectAnchors(preview);
      if (anchors.length < 1) return;
      const line = Math.max(1, ed.getTopVisibleLine());
      let lower = anchors[0];
      let upper = anchors[anchors.length - 1];
      for (let i = 0; i < anchors.length - 1; i++) {
        if (anchors[i].line <= line && anchors[i + 1].line >= line) {
          lower = anchors[i];
          upper = anchors[i + 1];
          break;
        }
      }
      const spanLines = Math.max(1, upper.line - lower.line);
      const frac = Math.min(1, Math.max(0, (line - lower.line) / spanLines));
      const target = lower.el.offsetTop + frac * (upper.el.offsetTop - lower.el.offsetTop);
      preview.scrollTo({ top: Math.max(0, target - 24), behavior: "auto" });
    };

    const previewToEditor = () => {
      const ed = editorRef.current;
      const preview = previewRef.current;
      if (!ed || !preview) return;
      const anchors = collectAnchors(preview);
      if (!anchors.length) return;
      const top = preview.scrollTop + 8;
      let visible = anchors[0];
      for (const a of anchors) {
        if (a.el.offsetTop <= top) visible = a;
        else break;
      }
      lastEditorDrive = Date.now();
      ed.scrollTop(visible.line);
    };

    const edInstance = editorRef.current as unknown as {
      onScroll?: (fn: () => void) => () => void;
    } | null;
    let disposeScroll: (() => void) | undefined;
    if (edInstance?.onScroll) {
      disposeScroll = edInstance.onScroll(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          editorToPreview();
        });
      });
    }

    const previewEl = previewRef.current;
    const handler = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        previewToEditor();
      });
    };
    previewEl?.addEventListener("scroll", handler, { passive: true });

    return () => {
      disposeScroll?.();
      previewEl?.removeEventListener("scroll", handler);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editorRef, previewRef]);
}
