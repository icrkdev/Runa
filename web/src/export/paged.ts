const CONFIRM_COPY =
  "This writes an unencrypted file to your computer. RÚNA cannot shred that copy.";

let confirmedThisSession = false;
let pagedLoader: Promise<PagedModule> | null = null;

/// How much text goes on a page.
///
/// The print stylesheet set page size, margins and break rules but never
/// touched type size, so the PDF inherited the preview's 16px screen
/// typography and there was no way to change it. A 2 500-line document came
/// out at sixty-odd pages with no recourse.
///
/// Margins move with the type rather than being held fixed. On A4 the margins
/// are a large share of the page, so shrinking the type alone buys far less
/// than it looks like it should — the two have to travel together to make a
/// real difference to the page count.
export type ExportDensity = "compact" | "normal" | "roomy";

const DENSITY: Record<
  ExportDensity,
  { body: string; line: string; mono: string; margin: string }
> = {
  compact: { body: "8.5pt", line: "1.3", mono: "7.5pt", margin: "1cm 1.1cm 1.4cm" },
  normal: { body: "10.5pt", line: "1.5", mono: "9.5pt", margin: "1.5cm 1.6cm 2cm" },
  roomy: { body: "12.5pt", line: "1.7", mono: "11pt", margin: "1.9cm 2cm 2.3cm" },
};

export function printCss(density: ExportDensity): string {
  const d = DENSITY[density] ?? DENSITY.normal;
  return `
@page {
  size: A4;
  margin: ${d.margin};
  @bottom-center { content: counter(page) " / " counter(pages); }
}
@page :first { @bottom-center { content: none; } }
.preview-body, .pagedjs_page { font-size: ${d.body}; line-height: ${d.line}; }
pre, code, kbd, samp { font-size: ${d.mono}; tab-size: 2; white-space: pre-wrap; word-break: break-word; }
pre { break-inside: avoid; }
table, blockquote, figure, .katex-display, math[display="block"] { break-inside: avoid; }
h1, h2, h3, h4 { break-after: avoid; }
p, li { orphans: 3; widows: 3; }
a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.8em; }
.pagedjs_page { background: white; }
`;
}

interface PagedPreviewer {
  preview(
    content: string,
    styles: Array<string | { textContent: string }>,
    renderTo: Element | Document,
  ): Promise<unknown>;
}

interface PagedModule {
  Previewer?: new () => PagedPreviewer;
}

async function loadPaged(): Promise<PagedModule> {
  pagedLoader ??= import("pagedjs").then((m) => m as unknown as PagedModule);
  return pagedLoader;
}

export async function exportPdf(density: ExportDensity = "normal"): Promise<void> {
  if (!confirmedThisSession && !window.confirm(CONFIRM_COPY)) return;
  confirmedThisSession = true;

  const sourceHtml = document.querySelector(".preview-body")?.innerHTML ?? "";
  if (!sourceHtml) {
    window.print();
    return;
  }

  document.body.classList.add("paged-mode");
  try {
    const { Previewer: MaybePreviewer } = await loadPaged();
    if (!MaybePreviewer) throw new Error("pagedjs Previewer unavailable");
    const Previewer = MaybePreviewer;
    const host = document.createElement("div");
    host.id = "runa-paged-host";
    document.body.append(host);

    const previewer = new Previewer();
    await previewer.preview(sourceHtml, [{ textContent: printCss(density) }], host);
    await new Promise((r) => setTimeout(r, 250));

    window.print();
    await new Promise((r) => setTimeout(r, 400));
    host.remove();
  } catch {
    window.print();
  } finally {
    document.body.classList.remove("paged-mode");
  }
}

export function defaultFilename(): string {
  return "runa-export.pdf";
}
