import type { Schema } from "hast-util-sanitize";

export const RUNA_SCHEMA = {
  tagNames: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "div", "span", "section",
    "a",
    "blockquote", "pre", "code", "kbd", "samp",
    "hr", "br", "wbr",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "strong", "em", "b", "i", "s", "del", "ins", "mark", "sub", "sup", "small", "abbr", "cite", "q",
    "dl", "dt", "dd",
    "input",
    "img", "picture", "source",
    "svg", "math", "annotation", "semantics", "mrow", "mi", "mn", "mo", "msup", "msub", "mfrac", "mroot", "msqrt", "mtext", "mspace", "mstyle", "munderover", "munder", "mover", "mmultiscripts", "mprescripts", "mtable", "mtr", "mtd", "mphantom",
    "details", "summary", "time", "var",
  ],
  attributes: {
    "*": [
      ["className", /^hljs(-|$)/],
      ["className", /^katex(-|$)/],
      ["className", /^math(n|ml|-)/],
      ["className", /^language-/],
      ["className", /^task-list/],
      ["className", /^(contains-task-list|checkbox)/],
      ["className", /^external-/],
      ["className", /^runa-inline-/],
    ],
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    input: [["type", "checkbox"], "disabled", "checked"],
    th: ["scope", "colspan", "rowspan", ["align", "left", "right", "center"]],
    td: ["colspan", "rowspan", ["align", "left", "right", "center"]],
    code: ["className"],
    span: ["className", "aria-hidden", "dataAlt"],
    div: ["className", "aria-hidden"],
    svg: [
      "viewBox", "preserveAspectRatio", "xmlns", "width", "height", "fill", "stroke",
      "strokeWidth", "strokeLinecap", "strokeLinejoin", "display", "role",
      ["aria-hidden"],
    ],
    path: ["d", "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin"],
    annotation: [["encoding"]],
    math: [["xmlns", "http://www.w3.org/1998/Math/MathML"], "display"],
    details: ["open"],
  },
  strip: ["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form", "button"],
  clobberPrefix: "runa-clobber-",
} as unknown as Schema;

export const MAX_NESTING_DEPTH = 100;

export function exceedsNestingDepth(node: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING_DEPTH) return true;
  if (node === null || typeof node !== "object") return false;
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return false;
  return children.some((child) => exceedsNestingDepth(child, depth + 1));
}
