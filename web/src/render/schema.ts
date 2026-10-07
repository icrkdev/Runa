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
    // No SVG. These existed for exactly one producer: KaTeX's HTML output,
    // which drew radicals, stretchy delimiters and rules as inline SVG. The
    // renderer emits MathML now — a radical is <msqrt> and the browser draws
    // the rule — so nothing in the pipeline generates SVG at all.
    //
    // This is defence in depth rather than closing an open hole: remarkRehype
    // runs with allowDangerousHtml:false, so a hostile document cannot inject
    // raw <svg> in the first place, and the allowlist was only ever reachable
    // by nodes a plugin generated. It is removed because an allowance with no
    // producer is surface kept alive by habit.
    //
    // Mermaid, if it is ever added, renders by generating SVG and will need
    // some of this back. That should be a deliberate decision scoped to what
    // Mermaid actually emits, not something inherited from a library that no
    // longer runs.
    "math", "annotation", "semantics", "mrow", "mi", "mn", "mo", "msup", "msub", "mfrac", "mroot", "msqrt", "mtext", "mspace", "mstyle", "munderover", "munder", "mover", "mmultiscripts", "mprescripts", "mtable", "mtr", "mtd", "mphantom",
    // Three KaTeX emits that were missing, so the sanitizer dropped the element
    // and kept its children: \int_0^\infty came out as "∫ 0 ∞". msubsup is a
    // sub- and superscript on one base (integral and sum limits); menclose is
    // \cancel and \boxed; mpadded is \hphantom and labelled arrows. None can
    // carry a URL or script. Found by rendering a corpus and listing every
    // element the schema stripped.
    "msubsup", "menclose", "mpadded",
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
    annotation: [["encoding"]],
    math: [["xmlns", "http://www.w3.org/1998/Math/MathML"], "display"],
    // Without `notation`, MathML draws a long-division sign, so \boxed{y} would
    // render as something else entirely. Only the values KaTeX emits.
    menclose: [["notation", /^(box|updiagonalstrike|downdiagonalstrike|horizontalstrike)( (updiagonalstrike|downdiagonalstrike))?$/]],
    // Lengths only. `mathbackground` (\colorbox) stays out for the same reason
    // \color does: text coloured to match the page can hide content in a
    // shared document.
    mpadded: [
      ["width", /^[+-]?\d*\.?\d+(em|ex|pt|px|mu)?$/],
      ["height", /^[+-]?\d*\.?\d+(em|ex|pt|px|mu)?$/],
      ["depth", /^[+-]?\d*\.?\d+(em|ex|pt|px|mu)?$/],
      ["lspace", /^[+-]?\d*\.?\d+(em|ex|pt|px|mu)?$/],
      ["voffset", /^[+-]?\d*\.?\d+(em|ex|pt|px|mu)?$/],
    ],
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
