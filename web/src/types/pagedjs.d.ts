declare module "pagedjs" {
  export class Previewer {
    preview(
      content: string,
      styles: Array<string | { textContent: string }>,
      renderTo: Element | Document,
    ): Promise<unknown>;
  }
}
