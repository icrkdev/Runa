const CONFIRM_COPY =
  "This writes an unencrypted file to your computer. RÚNA cannot shred that copy.";

let confirmedThisSession = false;
let pagedLoader: Promise<PagedModule> | null = null;

const PRINT_CSS = `
@page {
  size: A4;
  margin: 1.5cm 1.6cm 2cm;
  @bottom-center { content: counter(page) " / " counter(pages); }
}
@page :first { @bottom-center { content: none; } }
pre, code, kbd, samp { tab-size: 2; white-space: pre-wrap; word-break: break-word; }
pre { break-inside: avoid; }
table, blockquote, figure, .katex-display { break-inside: avoid; }
h1, h2, h3, h4 { break-after: avoid; }
p, li { orphans: 3; widows: 3; }
a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.8em; }
.pagedjs_page { background: white; }
`;

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

export async function exportPdf(): Promise<void> {
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
    await previewer.preview(sourceHtml, [{ textContent: PRINT_CSS }], host);
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
