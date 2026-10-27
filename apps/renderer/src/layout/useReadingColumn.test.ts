import { describe, expect, it } from "vitest";
import { readingColumnGeometry, type ReadingColumnPreference } from "./useReadingColumn";

const standard: ReadingColumnPreference = { mode: "standard", customWidth: 1024 };

describe("main reading column geometry", () => {
  it.each([
    ["standard", 768],
    ["wide", 1024],
    ["custom", 1280],
  ] as const)("preserves the %s preset's net reading width when space permits", (mode, width) => {
    expect(readingColumnGeometry(1800, { mode, customWidth: 1280 }, false))
      .toEqual({ width, gutter: 32, rail: 44, scrollbar: 0, minimap: true });
  });

  it("uses a finite real available width in full mode", () => {
    expect(readingColumnGeometry(1800, { ...standard, mode: "full" }, false).width).toBe(1692);
    expect(readingColumnGeometry(1800, { ...standard, mode: "full" }, true, 1, 8).width).toBe(1728);
  });

  it.each([
    [479, 12, 0, false],
    [480, 16, 0, false],
    [719, 16, 0, false],
    [720, 32, 44, true],
  ])("uses actual column width %i for gutters and minimap visibility", (container, gutter, rail, minimap) => {
    const geometry = readingColumnGeometry(Number(container), standard, false);
    expect(geometry).toMatchObject({ gutter, rail, minimap });
    expect(geometry.width).toBe(Number(container) - Number(gutter) * 2 - Number(rail));
  });

  it("gives welcome the selected composer cap without a minimap rail", () => {
    expect(readingColumnGeometry(1200, standard, true, 1, 8))
      .toEqual({ width: 768, gutter: 32, rail: 0, scrollbar: 8, minimap: false });
  });

  it("scales gutters with density without scaling the user's selected reading width", () => {
    expect(readingColumnGeometry(1200, standard, false, 0.85))
      .toMatchObject({ width: 768, gutter: 27.2, rail: 44 });
    expect(readingColumnGeometry(600, standard, false, 1.15, 8).width).toBeCloseTo(555.2);
  });

  it.each([500, 1200])("aligns document and composer at %i pixels with a native scrollbar", (container) => {
    const { width, gutter, rail, scrollbar } = readingColumnGeometry(container, standard, true, 1, 8);
    const documentBox = Math.min(container - scrollbar, width + 2 * gutter + rail);
    const documentLeft = (container - scrollbar - documentBox) / 2 + gutter;
    const documentRight = documentLeft + documentBox - 2 * gutter - rail;
    const composerBox = container - 2 * gutter - rail - scrollbar;
    const composerLeft = gutter + (composerBox - width) / 2;
    expect(composerLeft).toBe(documentLeft);
    expect(composerLeft + width).toBe(documentRight);
  });

  it("does not reserve a hidden native scrollbar while the minimap is on", () => {
    expect(readingColumnGeometry(900, standard, false, 1, 8)).toMatchObject({ width: 768, scrollbar: 0 });
  });
});
