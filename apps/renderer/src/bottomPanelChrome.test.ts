import { describe, expect, it } from "vitest";
import { toggleBottomBarOpen, toggleBottomBarVisible } from "./bottomPanelChrome";

describe("bottom bar chrome", () => {
  it("hides an expanded bar without collapsing the tab body, then restores expanded", () => {
    const hidden = toggleBottomBarVisible({ visible: true, open: true });
    expect(hidden).toEqual({ visible: false, open: true });
    expect(toggleBottomBarVisible(hidden)).toEqual({ visible: true, open: true });
  });

  it("hides a collapsed tab strip without expanding it, then restores collapsed", () => {
    const hidden = toggleBottomBarVisible({ visible: true, open: false });
    expect(hidden).toEqual({ visible: false, open: false });
    expect(toggleBottomBarVisible(hidden)).toEqual({ visible: true, open: false });
  });

  it("lets Ctrl+J show a hidden bar without flipping the remembered collapse state", () => {
    expect(toggleBottomBarOpen({ visible: false, open: false })).toEqual({ visible: true, open: false });
    expect(toggleBottomBarOpen({ visible: false, open: true })).toEqual({ visible: true, open: true });
  });

  it("lets Ctrl+J keep toggling the tab body while the bar is on screen", () => {
    expect(toggleBottomBarOpen({ visible: true, open: true })).toEqual({ visible: true, open: false });
    expect(toggleBottomBarOpen({ visible: true, open: false })).toEqual({ visible: true, open: true });
  });
});
