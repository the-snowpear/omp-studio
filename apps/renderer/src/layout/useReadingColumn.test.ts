// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readingColumnGeometry,
  readingColumnHeightTier,
  SHORT_COLUMN_HYSTERESIS,
  SHORT_COLUMN_MAX,
  TIGHT_COLUMN_MAX,
  useReadingColumn,
  type ReadingColumnPreference,
} from "./useReadingColumn";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("classifies short reading column heights into compact and tight tiers with hysteresis", () => {
    expect(readingColumnHeightTier(0)).toBeUndefined();
    expect(readingColumnHeightTier(SHORT_COLUMN_MAX + 1)).toBeUndefined();
    expect(readingColumnHeightTier(SHORT_COLUMN_MAX)).toBe("compact");
    expect(readingColumnHeightTier(TIGHT_COLUMN_MAX + 1)).toBe("compact");
    expect(readingColumnHeightTier(TIGHT_COLUMN_MAX)).toBe("tight");

    // Hysteresis keeps the composer steady when dragging along a tier boundary.
    expect(readingColumnHeightTier(TIGHT_COLUMN_MAX + SHORT_COLUMN_HYSTERESIS, "tight")).toBe("tight");
    expect(readingColumnHeightTier(TIGHT_COLUMN_MAX + SHORT_COLUMN_HYSTERESIS + 1, "tight")).toBe("compact");
    expect(readingColumnHeightTier(SHORT_COLUMN_MAX + SHORT_COLUMN_HYSTERESIS, "compact")).toBe("compact");
    expect(readingColumnHeightTier(SHORT_COLUMN_MAX + SHORT_COLUMN_HYSTERESIS + 1, "compact")).toBeUndefined();
    expect(readingColumnHeightTier(SHORT_COLUMN_MAX + SHORT_COLUMN_HYSTERESIS + 1, "tight")).toBeUndefined();
  });

  it("writes and clears data-reading-short as the conversation container height changes", () => {
    let height = 720;
    const element = document.createElement("div");
    element.className = "convo-wrap";
    document.body.appendChild(element);
    vi.spyOn(element, "clientWidth", "get").mockReturnValue(960);
    vi.spyOn(element, "clientHeight", "get").mockImplementation(() => height);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const flushFrames = () => {
      while (frames.length > 0) frames.shift()?.(0);
    };

    const ref = { current: element };
    const { unmount } = renderHook(() => useReadingColumn(ref, standard, false));
    expect(element.dataset.readingShort).toBeUndefined();
    expect(element.style.getPropertyValue("--reading-height")).toBe("720px");

    height = 510;
    act(() => {
      window.dispatchEvent(new Event("resize"));
      flushFrames();
    });
    expect(element.dataset.readingShort).toBe("compact");
    expect(element.style.getPropertyValue("--reading-height")).toBe("510px");

    height = 340;
    act(() => {
      window.dispatchEvent(new Event("resize"));
      flushFrames();
    });
    expect(element.dataset.readingShort).toBe("tight");

    height = 640;
    act(() => {
      window.dispatchEvent(new Event("resize"));
      flushFrames();
    });
    expect(element.dataset.readingShort).toBeUndefined();

    unmount();
    element.remove();
  });
});
