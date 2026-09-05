import { describe, expect, it } from "vitest";
import { printCss, type ExportDensity } from "./paged";

const fontPt = (css: string) =>
  Number(/\.preview-body, \.pagedjs_page \{ font-size: ([\d.]+)pt/.exec(css)?.[1]);
const marginCm = (css: string) => Number(/margin: ([\d.]+)cm/.exec(css)?.[1]);

describe("print density", () => {
  it("sets a type size at all, which the stylesheet never used to", () => {
    // Which is why a 2 500-line document came out at sixty-odd pages with no
    // recourse: the PDF inherited the preview's screen typography.
    expect(printCss("normal")).toContain("font-size:");
  });

  it("gets smaller from roomy to compact", () => {
    expect(fontPt(printCss("compact"))).toBeLessThan(fontPt(printCss("normal")));
    expect(fontPt(printCss("normal"))).toBeLessThan(fontPt(printCss("roomy")));
  });

  it("moves the margins with the type, or the saving barely lands", () => {
    // On A4 the margins are a large share of the page. Shrinking type while
    // holding them fixed buys far less than it looks like it should.
    expect(marginCm(printCss("compact"))).toBeLessThan(marginCm(printCss("normal")));
    expect(marginCm(printCss("normal"))).toBeLessThan(marginCm(printCss("roomy")));
  });

  it("compact really is a large step, not a token one", () => {
    // The dialog claims compact fits roughly twice as much as large. Area per
    // line scales with font size times line height, so this keeps that copy
    // honest rather than aspirational.
    const area = (css: string) => fontPt(css) * Number(/line-height: ([\d.]+)/.exec(css)?.[1]);
    expect(area(printCss("roomy")) / area(printCss("compact"))).toBeGreaterThan(1.8);
  });

  it("keeps the break rules at every size", () => {
    for (const d of ["compact", "normal", "roomy"] as ExportDensity[]) {
      expect(printCss(d)).toContain("break-inside: avoid");
      expect(printCss(d)).toContain('math[display="block"]');
      expect(printCss(d)).toContain("orphans: 3");
    }
  });

  it("falls back to normal rather than emitting undefined for a bad value", () => {
    expect(printCss("nonsense" as ExportDensity)).toBe(printCss("normal"));
  });
});
