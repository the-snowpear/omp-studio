import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { DockProvider, DockPanel, DockSlot, useDock } from "./DockContext";
import { WORKBENCH_PANELS } from "../panels/registry";
import { beginDockDrag, dockHitTest } from "./gestures";
import { DockStore } from "./store";
import { locatePanel } from "./model";
import type { DockRegionId } from "./types";

let frame: (() => void)[] = [];
function flush() { act(() => { const batch = frame; frame = []; batch.forEach(fn => fn()); }); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); frame = []; document.body.innerHTML = ""; });
function geometry() {
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frame.push(fn); return frame.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.classList.contains("adaptive-workbench") ? 1400 : 400, this.classList.contains("adaptive-workbench") ? 900 : 280);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 400, 280)] as unknown as DOMRectList);
}

describe("dock content lifetime", () => {
  it("keeps the same content through all five placements, hiding and restoring", () => {
    geometry();
    let store!: DockStore;
    const mounted = vi.fn(), unmounted = vi.fn();
    function Body() { useEffect(() => { mounted(); return unmounted; }, []); return <input aria-label="retained draft" defaultValue="keep me" />; }
    function Surface() {
      const dock = useDock(); store = dock.store;
      const location = locatePanel(dock.layout, "terminal");
      return <><div className="adaptive-workbench"><section key={location?.region ?? "hidden"}>{location && <DockSlot id="terminal" />}</section></div><DockPanel id="terminal"><Body /></DockPanel></>;
    }
    render(<DockProvider definitions={WORKBENCH_PANELS}><Surface /></DockProvider>);
    flush(); flush();
    const input = document.querySelector<HTMLInputElement>('[aria-label="retained draft"]')!;
    input.value = "edited";
    for (const region of ["left", "rail", "right", "bottom", "float"] as const) {
      act(() => store.dispatch({ type: "move", panels: ["terminal"], target: { region } }));
      flush();
      expect(document.querySelector('[aria-label="retained draft"]')).toBe(input);
      expect(input.value).toBe("edited");
      expect(document.querySelectorAll('[data-panel="terminal"]')).toHaveLength(1);
    }
    act(() => store.dispatch({ type: "hide", panels: ["terminal"] })); flush();
    expect(input.closest<HTMLElement>('[data-panel]')?.hidden).toBe(true);
    act(() => store.dispatch({ type: "open", panel: "terminal" })); flush(); flush();
    expect(document.querySelector('[aria-label="retained draft"]')).toBe(input);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });
});

describe("dock pointer protocol", () => {
  function setup() {
    geometry();
    const store = new DockStore(null);
    render(<div className="adaptive-workbench"><header data-testid="source" onPointerDown={event => beginDockDrag(event, store, ["files"])}>Files</header><div data-dock-entry="right">Right</div></div>);
    const source = document.querySelector("header")!;
    const target = document.querySelector('[data-dock-entry]')!;
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [target] });
    return { store, source };
  }
  it("does not edit layout until drop, and cancels with Escape", () => {
    const { store, source } = setup();
    const start = store.getSnapshot().layout;
    fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 100 }); flush();
    expect(store.getSnapshot().layout).toBe(start);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 100 });
    expect(store.getSnapshot().layout).toBe(start);
    expect(document.querySelector(".dock-drag-preview")).toBeNull();
  });
  it("names distinct region entries and disables snapping for floating", () => {
    setup();
    expect(dockHitTest(200, 100, true)?.target.region).toBe("right");
    expect(dockHitTest(200, 100, false)?.target.region).toBe("float");
    expect(dockHitTest(-10, 100, false)).toBeNull();
    for (const region of ["left", "rail", "right", "bottom"] satisfies DockRegionId[]) {
      document.querySelector<HTMLElement>('[data-dock-entry]')!.dataset.dockEntry = region;
      expect(dockHitTest(200, 100, true)?.target.region).toBe(region);
    }
  });
});
