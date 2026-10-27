import { describe, expect, it } from "vitest";
import { fitWorkbench, type WorkbenchPreferences } from "./workbenchLayout";

const prefs: WorkbenchPreferences = { collapsed: false, sidebarWidth: 272, sideOpen: true, panelWidth: 480, bottomVisible: true, bottomOpen: true, bottomHeight: 240 };
const at = (width: number, height = 800, composerHeight = 160) => ({ width, height, composerHeight });

describe("workbench space budget", () => {
  it("shrinks panels, then hides the auxiliary panel, then the sidebar", () => {
    expect(fitWorkbench(prefs, at(1600))).toMatchObject({ sidebarWidth: 272, panelWidth: 480, sidebarShown: true, sideShown: true });
    expect(fitWorkbench(prefs, at(1280))).toMatchObject({ sidebarWidth: 272, panelWidth: 448, sidebarShown: true, sideShown: true });
    expect(fitWorkbench(prefs, at(1024))).toMatchObject({ sidebarWidth: 272, sidebarShown: true, sideShown: false });
    expect(fitWorkbench(prefs, at(800))).toMatchObject({ sidebarWidth: 240, sidebarShown: true, sideShown: false });
    expect(fitWorkbench(prefs, at(640))).toMatchObject({ sidebarShown: false, sideShown: false, overlay: null });
  });
  it("restores the saved layout without changing preferences", () => {
    const original = { ...prefs };
    const narrow = fitWorkbench(prefs, at(480));
    const wide = fitWorkbench(prefs, at(1600), null, narrow);
    expect(wide).toMatchObject({ sidebarWidth: 272, panelWidth: 480, sidebarShown: true, sideShown: true });
    expect(prefs).toEqual(original);
    expect(fitWorkbench({ ...prefs, sideOpen: false }, at(2560))).toMatchObject({ sideShown: false });
  });
  it("allows manual opening as an overlay without consuming the conversation", () => {
    expect(fitWorkbench(prefs, at(480), "sidebar")).toMatchObject({ sidebarShown: true, sidebarWidth: 272, sideShown: false, overlay: "sidebar" });
    expect(fitWorkbench(prefs, at(480), "side")).toMatchObject({ sideShown: true, panelWidth: 456, sidebarShown: false, overlay: "side" });
    expect(fitWorkbench(prefs, at(1024), "side")).toMatchObject({ sideShown: true, sidebarShown: false, overlay: null });
  });
  it("waits for extra room before restoring a hidden panel", () => {
    const narrow = fitWorkbench(prefs, at(700));
    expect(fitWorkbench(prefs, at(770), null, narrow).sidebarShown).toBe(false);
    expect(fitWorkbench(prefs, at(800), null, narrow).sidebarShown).toBe(true);
  });
  it("folds the bottom bar in short windows and restores it when taller", () => {
    const short = fitWorkbench(prefs, at(1280, 380));
    expect(short).toMatchObject({ bottomVisible: true, bottomOpen: false });
    expect(fitWorkbench(prefs, at(1280, 300))).toMatchObject({ bottomVisible: false, bottomOpen: false });
    expect(fitWorkbench(prefs, at(1280, 300), "bottom")).toMatchObject({ bottomVisible: true, bottomOpen: true, overlay: "bottom" });
    expect(fitWorkbench(prefs, at(1280), null, short)).toMatchObject({ bottomVisible: true, bottomOpen: true, bottomHeight: 240 });
  });
});
