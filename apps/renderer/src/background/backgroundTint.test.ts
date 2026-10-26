import { describe, expect, it } from "vitest";

import {
  autoScrim,
  contrastRatio,
  estimateReadability,
  mixHexColor,
  parseHexColor,
  relativeLuminance,
  titlebarTint,
  toHexColor,
} from "./backgroundTint";

describe("background colour math", () => {
  it("parses and round-trips hex colours", () => {
    expect(parseHexColor("#1d2129")).toEqual({ r: 29, g: 33, b: 41 });
    expect(parseHexColor("#GGGGGG")).toBeUndefined();
    expect(toHexColor({ r: 255, g: 0, b: 16 })).toBe("#ff0010");
    expect(mixHexColor("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHexColor("#123456", "#abcdef", 1)).toBe("#abcdef");
  });

  it("computes luminance and WCAG contrast", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 3);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("finds the smallest scrim that keeps the estimated contrast", () => {
    const cases = [
      { theme: "light" as const, avg: "#22243c" },
      { theme: "light" as const, avg: "#e2dacc" },
      { theme: "dark" as const, avg: "#0f1424" },
      { theme: "dark" as const, avg: "#e2dacc" },
    ];
    for (const entry of cases) {
      for (const strength of [0, 35, 80]) {
        const input = { opacity: 70, strength, avgColor: entry.avg };
        const scrim = autoScrim(entry.theme, input);
        expect(scrim % 5).toBe(0);
        expect(scrim).toBeGreaterThanOrEqual(entry.theme === "light" ? 20 : 25);
        if (scrim < 95) {
          expect(estimateReadability({ ...input, scrim }, entry.theme)).toBeGreaterThanOrEqual(4.6);
        }
      }
    }
  });

  it("needs a thicker dark veil for bright art in the dark theme", () => {
    const strength = 100;
    const dark = autoScrim("dark", { opacity: 70, strength, avgColor: "#22243c" });
    const bright = autoScrim("dark", { opacity: 70, strength, avgColor: "#e2dacc" });
    expect(bright).toBeGreaterThan(dark);
  });

  it("picks a readable caption tint for both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const avg of ["#000000", "#ffffff", "#2255aa", "#ddcc99"]) {
        const tint = titlebarTint(theme, avg);
        expect(tint.color).toMatch(/^#[0-9a-f]{6}$/u);
        expect(tint.symbolColor).toMatch(/^#[0-9a-f]{6}$/u);
        expect(contrastRatio(tint.symbolColor, tint.color)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("estimates readability from the composite layers", () => {
    const base = { opacity: 70, strength: 35, scrim: 45, avgColor: "#2255aa" };
    const light = estimateReadability(base, "light");
    expect(light).toBeGreaterThan(1);
    expect(estimateReadability({ ...base, scrim: 85 }, "light")).toBeGreaterThan(light);
    expect(estimateReadability({ ...base, strength: 0 }, "light")).toBeGreaterThan(light);
    expect(estimateReadability({ ...base, opacity: 100 }, "light")).toBeLessThan(light);
  });
});
