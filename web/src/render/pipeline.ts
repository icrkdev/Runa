import { unified } from "unified";
import { visit, SKIP } from "unist-util-visit";
import type { Element, Root } from "hast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { RUNA_SCHEMA, MAX_NESTING_DEPTH } from "./schema";

const katexOptions = {
  trust: false,
  strict: "warn",
  maxSize: 25,
  maxExpand: 1000,
  throwOnError: false,
  output: "html",
} as const;

const HIGHLIGHT_MAX_BYTES = 100 * 1024;

function stripLanguageForHugeBlocks() {
  return (tree: Root) => {
    visit(tree, "element", (el: Element) => {
      if (el.tagName !== "pre") return;
      const codeEl = el.children.find(
        (c): c is Element => c.type === "element" && c.tagName === "code",
      );
      if (!codeEl) return;
      let size = 0;
      visit(codeEl, (n) => {
        if (n.type === "text") size += n.value.length;
      });
      if (size > HIGHLIGHT_MAX_BYTES && Array.isArray(codeEl.properties?.className)) {
        codeEl.properties.className = (codeEl.properties.className as string[]).filter(
          (cls) => !String(cls).startsWith("language-"),
        );
      }
      return SKIP;
    });
  };
}

function capNestingDepth() {
  const cut = (node: Element, depth: number): void => {
    if (depth >= MAX_NESTING_DEPTH) {
      node.children = [];
      return;
    }
    for (const child of node.children) {
      if (child.type === "element") cut(child, depth + 1);
    }
  };
  return (tree: Root) => {
    for (const child of tree.children) {
      if (child.type === "element") cut(child, 0);
    }
    return tree;
  };
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(https:|mailto:)/i;
/// Leading C0 control characters and spaces are stripped by the HTML parser
/// before the scheme is read, so `\tjavascript:` runs. Strip them here too
/// before deciding, rather than letting the regex miss.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const stripLeadingControl = (href: string): string => href.replace(/^[\u0000-\u0020]+/, "");
const isSafeHref = (href: string): boolean => {
  const h = stripLeadingControl(href);
  return !HAS_SCHEME.test(h) || SAFE_SCHEME.test(h);
};
/// Scheme-relative (`//host/path`) leaves the origin just as surely as an
/// absolute URL does. Treating it as internal meant it got no `noopener`,
/// no `noreferrer`, and no "you are leaving RÚNA" confirmation.
export const isExternalHref = (href: string): boolean => {
  const h = stripLeadingControl(href);
  return /^https?:\/\//i.test(h) || h.startsWith("//");
};

function enforceLinkProtocols() {
  return (tree: Root) => {
    visit(tree, "element", (el: Element) => {
      if (el.tagName === "a") {
        const href = String(el.properties?.href ?? "");
        if (!isSafeHref(href)) {
          delete el.properties.href;
        }
        if (el.properties.href && isExternalHref(href)) {
          el.properties.rel = ["noopener", "noreferrer", "nofollow"];
          el.properties.target = "_blank";
        }
      }
    });
    return tree;
  };
}


function restoreInlineImages() {
  return (tree: Root) => {
    visit(tree, "element", (el: Element, index, parent) => {
      if (
        el.tagName === "span" &&
        Array.isArray(el.properties?.className) &&
        (el.properties.className as string[]).includes("runa-inline-image") &&
        parent &&
        typeof index === "number"
      ) {
        const textChild = el.children.find(
          (c): c is { type: "text"; value: string } =>
            c.type === "text" && typeof c.value === "string",
        );
        // Re-check the scheme. This runs *after* rehype-sanitize, so it is
        // reconstructing an element the sanitiser has already signed off on
        // and will not see again. The value should only ever be a data URI
        // that `prepareImagesAndLinks` vetted, but a pass that rebuilds a
        // URL-bearing node behind the sanitiser has to carry its own check.
        if (textChild && SAFE_IMAGE_DATA.test(textChild.value)) {
          const altAttr = String(el.properties?.dataAlt ?? "");
          parent.children[index] = {
            type: "element",
            tagName: "img",
            properties: { src: textChild.value, alt: altAttr },
            children: [],
          };
        }
      }
    });
    return tree;
  };
}

const SAFE_IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);/i;

/// Runs BEFORE rehype-sanitize. hast-util-sanitize hard-codes protocol
/// checks on src/href and always strips data: URIs, so safe inline images
/// are carried through sanitisation as inert text-bearing spans.
function prepareImagesAndLinks() {
  return (tree: Root) => {
    visit(tree, "element", (el: Element) => {
      if (el.tagName === "img") {
        const src = String(el.properties?.src ?? "");
        if (SAFE_IMAGE_DATA.test(src)) {
          const altText = String(el.properties?.alt ?? "");
          el.tagName = "span";
          el.properties = { className: ["runa-inline-image"], "dataAlt": altText };
          el.children = [{ type: "text", value: src }];
        } else if (/^https?:\/\//i.test(src)) {
          let host = "unknown";
          try {
            host = new URL(src).hostname;
          } catch {
            void 0;
          }
          el.tagName = "span";
          el.properties = { className: ["external-chip"] };
          el.children = [{ type: "text", value: `EXTERNAL IMAGE BLOCKED · ${host}` }];
        } else {
          el.tagName = "span";
          el.properties = {};
          el.children = [];
        }
      }
    });
    return tree;
  };
}

function annotateSourceLines() {
  return (tree: Root) => {
    for (const child of tree.children) {
      if (child.type === "element" && child.position?.start.line != null) {
        child.properties ??= {};
        (child.properties as Record<string, unknown>)["dataSrcLine"] = child.position.start.line;
      }
    }
    return tree;
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(stripLanguageForHugeBlocks)
  .use(rehypeKatex, katexOptions)
  .use(rehypeHighlight, { detect: false })
  .use(capNestingDepth)
  .use(prepareImagesAndLinks)
  .use(rehypeSanitize, RUNA_SCHEMA)
  .use(enforceLinkProtocols)
  .use(restoreInlineImages)
  .use(annotateSourceLines)
  .use(rehypeStringify);

export interface RenderResult {
  html: string;
  srcLines: number[];
}

export async function renderMarkdown(source: string): Promise<RenderResult> {
  const vfile = await processor.process(source);
  return { html: String(vfile), srcLines: [] };
}
