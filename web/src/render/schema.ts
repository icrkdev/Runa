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
    // KaTeX draws radicals, stretchy delimiters and rules as inline SVG.
    // Allowing <svg> but not its children left every √ and every big brace
    // rendering as an empty box.
    "svg", "path", "line", "rect", "g", "defs", "use",
    "math", "annotation", "semantics", "mrow", "mi", "mn", "mo", "msup", "msub", "mfrac", "mroot", "msqrt", "mtext", "mspace", "mstyle", "munderover", "munder", "mover", "mmultiscripts", "mprescripts", "mtable", "mtr", "mtd", "mphantom",
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
    line: ["x1", "y1", "x2", "y2", "stroke", "strokeWidth", "strokeLinecap"],
    rect: ["x", "y", "width", "height", "fill"],
    g: ["fill", "stroke", "transform"],
    use: ["x", "y", "width", "height", "fill"],
    annotation: [["encoding"]],
    math: [["xmlns", "http://www.w3.org/1998/Math/MathML"], "display"],
    details: ["open"],
  },
  strip: [
    "script", "style", "iframe", "object", "embed", "link", "meta", "base",
    "form", "button", "foreignObject", "animate", "set", "handler",
  ],
  /// hast-util-sanitize only filters URL schemes for attributes named here.
  /// The schema replaces the library default wholesale, so omitting this key
  /// silently disabled protocol checking entirely and left `enforceLinkProtocols`
  /// as the only thing between a `javascript:` href and the DOM.
  protocols: {
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
    cite: ["http", "https"],
  },
  clobberPrefix: "runa-clobber-",
} as unknown as Schema;

export const MAX_NESTING_DEPTH = 100;
