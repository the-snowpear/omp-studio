import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockPanel, DockProvider, useDock } from "./DockContext";
import { DockCardRegion, DockFloatingLayer, DockRail } from "./DockRegions";
import { dragPreview } from "./dragPreview";
import { DockStore } from "./store";
import { WORKBENCH_PANELS } from "../panels/registry";
import type { PanelId } from "./types";

let frames: FrameRequestCallback[] = [];
const flush = () => act(() => { const batch = frames; frames = []; batch.forEach(callback => callback(0)); });
afterEach(() => { cleanup(); dragPreview.show(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); frames = []; });

function setup({ floating = [], mode = "expanded" }: { floating?: PanelId[]; mode?: "expanded" | "compact" } = {}) {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".adaptive-workbench, .convo-wrap")) return new DOMRect(0, 0, 1400, 900);
    if (this.matches(".composer-region")) return new DOMRect(0, 600, 1000, 300);
    if (this.matches(".sidebar")) return new DOMRect(0, 0, 240, 900);
    const card = this.closest<HTMLElement>(".dock-card-list > [data-dock-card]");
    if (card) {
      const index = [...card.parentElement!.children].indexOf(card);
      return new DOMRect(card.closest('.dock-card-region-left') ? 0 : 1060, 40 + index * 56, 318, 46);
    }
    return new DOMRect(1060, 40, 320, 800);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 320, 800)] as unknown as DOMRectList);
  const store = new DockStore(null);
  store.dispatch({ type: "railMode", mode });
  for (const panel of ["environment", "context", "agents"] as const) store.dispatch({ type: "card", panel, collapsed: true });
  if (floating.length) {
    for (const panel of floating) store.dispatch({ type: "card", panel, collapsed: false });
    store.dispatch({ type: "move", panels: floating, target: { region: "float", rect: { x: 100, y: 100, width: 560, height: 400 } } });
    if (floating.includes("agents")) store.dispatch({ type: "activate", groupId: store.getSnapshot().layout.floats[0]!.id, panel: "agents" });
  }
  function Surface() {
    const { layout } = useDock();
    return <><div className="adaptive-workbench"><aside className="sidebar"><DockCardRegion region="left" /></aside><div className="convo-wrap"><DockRail mode={layout.rail.mode} /><div className="composer-region">等待队列与输入框</div></div></div><DockFloatingLayer />
      <DockPanel id="agents"><input defaultValue="keep this draft" /></DockPanel>
      <DockPanel id="git"><div>Full Git</div></DockPanel>
      <DockPanel id="git-quick"><div>Git quick card</div></DockPanel></>;
  }
  render(<DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider>);
  flush(); flush();
  let destination = "rail";
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: (x: number) => x < 1000 && destination === "rail" ? [] : [document.querySelector(`.dock-card-list[data-dock-cards="${destination}"]`)!].filter(Boolean) });
  const header = () => document.querySelector<HTMLElement>('.dock-rail-expanded [data-dock-card="context"] .dock-card-header')!;
  const order = () => [...document.querySelectorAll<HTMLElement>('.dock-rail-expanded .dock-card-list > [data-dock-card]')].map(card => card.dataset.dockCard);
  const start = () => fireEvent.pointerDown(header(), { button: 0, pointerId: 1, clientX: 1200, clientY: 118 });
  const move = (y: number, x = 1200) => { fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y }); flush(); };
  const startFloat = () => fireEvent.pointerDown(document.querySelector('.dock-float-titlebar')!, { button: 0, pointerId: 1, clientX: 1200, clientY: 80 });
  return { store, order, start, startFloat, move, destination: (region: string) => { destination = region; } };
}

describe("conversation rail layout", () => {
  it("previews Git as a quick card when dragged into the rail, supports cancel and drop", () => {
    const { store, order, startFloat, move } = setup({ floating: ["git"] });
    startFloat(); move(118);
    expect(dragPreview.snapshot()?.panels).toEqual(["git-quick"]);
    expect(dragPreview.snapshot()?.target.region).toBe("rail");
    expect(dragPreview.snapshot()?.cards?.sizes["git-quick"]?.body).toBeGreaterThanOrEqual(280);
    expect(document.querySelector('.dock-drag-preview .dock-card-title')?.textContent).toBe("Git");
    expect(order()).toContain("git-quick");
    expect(store.getSnapshot().layout.rail.panels).not.toContain("git-quick");
    fireEvent.keyDown(window, { key: "Escape" }); flush();
    expect(dragPreview.snapshot()).toBeNull();
    expect(document.body.classList.contains("dock-dragging")).toBe(false);
    expect(order()).not.toContain("git-quick");

    startFloat(); move(48); move(48);
    expect(dragPreview.snapshot()?.panels).toEqual(["git-quick"]);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1200, clientY: 48 }); flush();
    expect(store.getSnapshot().layout.rail.panels).toContain("git-quick");
    expect(document.querySelector('[data-dock-card="git-quick"] .dock-card-title')?.textContent).toBe("Git");
    expect(store.getSnapshot().layout.floats[0]?.panels).toContain("git");
    expect(document.querySelector(".dock-card-placeholder")).toBeNull();
    expect(document.body.classList.contains("dock-dragging")).toBe(false);
  });

  it("previews every card in a dragged group containing Git", () => {
    const { store, startFloat, move, order } = setup({ floating: ["agents", "git"] });
    startFloat(); move(48);
    expect(dragPreview.snapshot()?.panels).toEqual(["agents", "git-quick"]);
    expect(order().slice(0, 2)).toEqual(["agents", "git-quick"]);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1200, clientY: 48 }); flush();
    expect(store.getSnapshot().layout.rail.panels.slice(0, 2)).toEqual(["agents", "git-quick"]);
    expect(store.getSnapshot().layout.floats[0]?.panels).toEqual(["git"]);
    expect(document.body.classList.contains("dock-dragging")).toBe(false);
  });

  it("makes room while sorting and restores the order on Escape", () => {
    const { store, order, start, move } = setup();
    start(); move(48);
    expect(order()).toEqual(["context", "environment", "agents"]);
    expect(store.getSnapshot().layout.rail.panels).toEqual(["environment", "context", "agents"]);
    move(48); move(48);
    expect(order()).toEqual(["context", "environment", "agents"]);
    fireEvent.keyDown(window, { key: "Escape" }); flush();
    expect(order()).toEqual(["environment", "context", "agents"]);
    expect(store.getSnapshot().layout.rail.panels).toEqual(order());
    expect(document.querySelector(".dock-drag-preview")).toBeNull();
  });

  it("saves the displayed order only when the dragged card is released", () => {
    const { store, order, start, move } = setup();
    start(); move(192);
    expect(order()).toEqual(["environment", "agents", "context"]);
    expect(store.getSnapshot().layout.rail.panels).toEqual(["environment", "context", "agents"]);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1200, clientY: 192 }); flush();
    expect(store.getSnapshot().layout.rail.panels).toEqual(["environment", "agents", "context"]);
    expect(order()).toEqual(store.getSnapshot().layout.rail.panels);
  });

  it("reserves the full conversation height beside queues and the composer", () => {
    setup();
    expect(document.querySelector<HTMLElement>(".dock-rail-expanded")!.style.bottom).toBe("12px");
    document.querySelector<HTMLElement>(".composer-region")!.style.height = "500px";
    fireEvent(window, new Event("resize")); flush(); flush();
    expect(document.querySelector<HTMLElement>(".dock-rail-expanded")!.style.bottom).toBe("12px");
  });

  it("reserves a slot for an incoming float and restores it on cancellation", () => {
    const { store, order, startFloat, move } = setup({ floating: ["environment"] });
    startFloat(); move(48);
    expect(order()).toEqual(["environment", "context", "agents"]);
    expect(store.getSnapshot().layout.rail.panels).toEqual(["context", "agents"]);
    expect(document.querySelector('.dock-rail-expanded [data-dock-card="environment"]')?.classList.contains("dock-card-placeholder")).toBe(true);
    move(48); move(48);
    expect(order()).toEqual(["environment", "context", "agents"]);
    fireEvent.keyDown(window, { key: "Escape" }); flush();
    expect(order()).toEqual(["context", "agents"]);
    expect(document.querySelector(".dock-card-placeholder")).toBeNull();
    expect(document.querySelector(".dock-float")?.classList.contains("dock-drag-source")).toBe(false);
  });

  it("inserts a floating group as cards and preserves its live draft on drop", () => {
    const { store, order, startFloat, move } = setup({ floating: ["environment", "agents"] });
    const input = document.querySelector<HTMLInputElement>('[data-panel="agents"] input')!;
    input.value = "edited draft";
    startFloat(); move(48);
    expect(order()).toEqual(["environment", "agents", "context"]);
    expect(document.querySelectorAll(".dock-rail-expanded .dock-card-placeholder")).toHaveLength(2);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1200, clientY: 48 }); flush();
    expect(store.getSnapshot().layout.rail.panels).toEqual(["environment", "agents", "context"]);
    expect(document.querySelector('[data-panel="agents"] input')).toBe(input);
    expect(input.value).toBe("edited draft");
    expect(document.querySelector(".dock-card-placeholder")).toBeNull();
  });

  it("uses the same slot projection when crossing into the left tools", () => {
    const { store, destination, move } = setup();
    destination("left");
    const source = document.querySelector('.dock-rail-expanded [data-dock-card="environment"] .dock-card-header')!;
    fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 1200, clientY: 62 });
    move(48, 120);
    expect([...document.querySelectorAll<HTMLElement>('.dock-card-region-left [data-dock-card]')].map(card => card.dataset.dockCard)).toEqual(["environment", "files"]);
    expect(source.closest('.dock-card')?.classList.contains("is-drag-away")).toBe(true);
    expect(store.getSnapshot().layout.left.panels).toEqual(["files"]);
    fireEvent.keyDown(window, { key: "Escape" }); flush();
    expect(document.querySelector(".dock-card-placeholder")).toBeNull();
    expect(source.closest('.dock-card')?.classList.contains("is-drag-away")).toBe(false);
  });

  it("hides the compact popup shell while its content is dragged away", async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const { store, move } = setup({ mode: "compact" });
    fireEvent.click(document.querySelector('[data-dock-rail-icon="agents"]')!); flush(); flush();
    const input = document.querySelector<HTMLInputElement>('[data-panel="agents"] input')!;
    const start = () => fireEvent.pointerDown(document.querySelector('.dock-rail-overlay .dock-card-header')!, { button: 0, pointerId: 1, clientX: 1200, clientY: 80 });
    start(); move(300, 500);
    expect(document.querySelector('.dock-rail-overlay')?.classList.contains("dock-drag-source")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" }); flush();
    expect(document.querySelector('.dock-rail-overlay')?.classList.contains("dock-drag-source")).toBe(false);
    expect(document.querySelector('[data-panel="agents"] input')).toBe(input);
    start(); move(300, 500);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 500, clientY: 300 }); flush();
    expect(store.getSnapshot().layout.rail.panels).not.toContain("agents");
    expect(document.querySelector('.dock-rail-overlay')).toBeNull();
    expect(document.querySelector('[data-panel="agents"] input')).toBe(input);
  });
});
