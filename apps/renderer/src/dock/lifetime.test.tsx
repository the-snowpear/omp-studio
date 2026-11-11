import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { DockProvider, DockPanel, DockSlot, useDock, useDockEngine } from "./DockContext";
import { PanelInstances, PanelRegistration } from "./PanelRegistration";
import { DockCardRegion, DockFloatingLayer, DockGroupRegion, DockRail } from "./DockRegions";
import { dragPreview } from "./dragPreview";
import { WORKBENCH_PANELS } from "../panels/registry";
import { beginDockDrag, dockHitTest, previewBounds } from "./gestures";
import { DockStore } from "./store";
import { createDefaultLayout, locatePanel } from "./model";
import type { DockRegionId } from "./types";
import type { PanelHosts } from "./hosts";

let frame = new Map<number, FrameRequestCallback>(), nextFrame = 0;
function flush() { act(() => { const batch = frame; frame = new Map(); batch.forEach(fn => fn(0)); }); }
afterEach(() => { cleanup(); window.dispatchEvent(new Event("pagehide")); dragPreview.show(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); frame.clear(); document.body.innerHTML = ""; });
function geometry() {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { const id = ++nextFrame; frame.set(id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frame.delete(id); });
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.classList.contains("adaptive-workbench") ? 1400 : 400, this.classList.contains("adaptive-workbench") ? 900 : 280);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 400, 280)] as unknown as DOMRectList);
}

describe("dock content lifetime", () => {
  it.each(["context-viewer", "annotations"] as const)("removes the %s backdrop as soon as a title drag starts", panel => {
    geometry();
    const store = new DockStore(null);
    render(<DockProvider definitions={WORKBENCH_PANELS} store={store}>
      <div className="adaptive-workbench" />
      <DockPanel id={panel}><input aria-label="context draft" defaultValue="keep" /></DockPanel>
      <DockFloatingLayer />
    </DockProvider>);
    act(() => store.dispatch({ type: "open", panel }));
    flush(); flush();
    const title = document.querySelector<HTMLElement>("[data-dock-modal] .dock-float-titlebar")!;
    const rect = locatePanel(store.getSnapshot().layout, panel)?.rect;
    const input = document.querySelector<HTMLInputElement>('[aria-label="context draft"]')!;
    fireEvent.pointerDown(title, { button: 0, pointerId: 1, clientX: 100, clientY: 40 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 103, clientY: 40 });
    expect(store.getSnapshot().modalPanel).toBe(panel);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 110, clientY: 40 });
    expect(store.getSnapshot().modalPanel).toBeNull();
    expect(document.querySelector(".dock-modal-backdrop")).toBeNull();
    expect(document.querySelector('[aria-label="context draft"]')).toBe(input);
    fireEvent.keyDown(window, { key: "Escape" });
    flush();
    expect(locatePanel(store.getSnapshot().layout, panel)?.rect).toEqual(rect);
    expect(store.getSnapshot().modalPanel).toBeNull();
    act(() => store.dispatch({ type: "hide", panels: [panel] }));
    act(() => store.dispatch({ type: "open", panel }));
    flush(); flush();
    expect(store.getSnapshot().modalPanel).toBe(panel);
    expect(document.querySelector(".dock-modal-backdrop")).not.toBeNull();
    expect(locatePanel(store.getSnapshot().layout, panel)?.rect).toEqual(rect);
    expect(document.querySelector('[aria-label="context draft"]')).toBe(input);
  });

  it.each(["context-viewer", "annotations"] as const)("keeps focus in the first %s and returns it when Esc closes the window", panel => {
    geometry();
    const store = new DockStore(null);
    const view = render(<DockProvider definitions={WORKBENCH_PANELS} store={store}>
      <div className="adaptive-workbench"><button aria-label="Context 构成详情">Context</button></div>
      <DockPanel id={panel}><button>Refresh snapshot</button></DockPanel>
      <DockFloatingLayer />
    </DockProvider>);
    const entry = view.getByRole("button", { name: "Context 构成详情" });
    entry.focus();
    act(() => store.dispatch({ type: "open", panel }));
    flush(); flush();
    const dialog = document.querySelector<HTMLElement>('[data-dock-modal]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector(".dock-modal-backdrop")).not.toBeNull();
    fireEvent.click(document.querySelector(".dock-modal-backdrop")!);
    expect(store.getSnapshot().modalPanel).toBe(panel);
    act(() => entry.focus());
    expect(document.activeElement).not.toBe(entry);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    flush();
    expect(store.getSnapshot().modalPanel).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

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

describe("dock tab chrome", () => {
  function setup() {
    geometry();
    const store = new DockStore(null);
    store.dispatch({ type: "move", panels: ["changes", "git", "browser", "computer"], target: { region: "right" } });
    store.dispatch({ type: "move", panels: ["files"], target: { region: "float" } });
    const mounted = vi.fn(), unmounted = vi.fn();
    function Body() { useEffect(() => { mounted(); return unmounted; }, []); return <input aria-label="floating draft" defaultValue="keep" />; }
    render(<DockProvider definitions={WORKBENCH_PANELS} store={store}><div className="adaptive-workbench"><DockGroupRegion region="right" visible /><DockGroupRegion region="bottom" visible /></div><DockFloatingLayer /><DockPanel id="files"><Body /></DockPanel></DockProvider>);
    flush(); flush();
    const groupId = store.getSnapshot().layout.floats[0]!.id;
    const float = () => document.querySelector<HTMLElement>(`[data-dock-float="${groupId}"]`)!;
    return { store, groupId, float, mounted, unmounted };
  }

  it("uses a standalone page until a second tool joins and preserves its body on collapse", () => {
    const { store, groupId, float, mounted, unmounted } = setup();
    const input = document.querySelector<HTMLInputElement>('[aria-label="floating draft"]')!;
    input.value = "edited";
    expect(float().querySelector('.dock-tab-strip')).toBeNull();
    expect(float().querySelector('.dock-group-body')?.getAttribute('aria-label')).toBe("Explorer");
    const header = float().querySelector<HTMLElement>('.dock-float-titlebar')!;
    const body = float().querySelector<HTMLElement>('.dock-group-body')!;
    for (const target of [header, body]) {
      Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [target] });
      expect(dockHitTest(100, 100, true)?.target).toEqual({ region: "float", groupId });
    }
    act(() => store.dispatch({ type: "move", panels: ["git"], target: { region: "float", groupId } })); flush();
    expect(float().querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(float().querySelector('.dock-group-grip, .dock-menu-button:not(.dock-pin-button)')).toBeNull();
    const close = float().querySelector<HTMLButtonElement>('[data-dock-tab="git"] .dock-tab-close')!;
    close.focus();
    fireEvent.click(close); flush(); flush();
    expect(float().querySelector('.dock-tab-strip')).toBeNull();
    expect(document.activeElement).toBe(float());
    expect(document.querySelector('[aria-label="floating draft"]')).toBe(input);
    expect(input.value).toBe("edited");
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
    act(() => store.dispatch({ type: "move", panels: ["git"], target: { region: "float", groupId } })); flush();
    act(() => store.dispatch({ type: "move", panels: ["git"], target: { region: "right" } })); flush();
    expect(float().querySelector('.dock-tab-strip')).toBeNull();
  });

  it("reveals each strip's left-edge grip only near the edge", () => {
    setup();
    for (const region of ["right", "bottom"]) {
      const strip = document.querySelector<HTMLElement>(`.dock-group-region-${region} .dock-tab-strip`)!;
      const grip = strip.querySelector<HTMLButtonElement>('.dock-group-grip')!;
      const visible = () => strip.classList.contains('is-grip-visible');
      expect(grip).not.toBeNull();
      expect(visible()).toBe(false);
      fireEvent.pointerMove(strip, { clientX: 100, clientY: 16 });
      expect(visible()).toBe(false);
      fireEvent.pointerMove(strip, { clientX: 8, clientY: 16 });
      expect(visible()).toBe(true);
      fireEvent.pointerMove(strip, { clientX: 24, clientY: 16 });
      expect(visible()).toBe(true);
      fireEvent.pointerMove(strip, { clientX: 80, clientY: 16 });
      expect(visible()).toBe(false);
      act(() => grip.focus());
      expect(visible()).toBe(true);
      act(() => strip.querySelector<HTMLButtonElement>('[role="tab"]')!.focus());
      expect(visible()).toBe(false);
    }
  });

  it("opens a new tab from the strip's pinned add button", () => {
    const { store } = setup();
    const strip = document.querySelector<HTMLElement>('.dock-group-region-right .dock-tab-strip')!;
    const add = strip.querySelector<HTMLButtonElement>('.dock-tab-add')!;
    expect(add).not.toBeNull();
    // A sibling of the scroller, so tab overflow can never scroll it away.
    expect(add.closest('[role="tablist"]')).toBeNull();
    // A short row keeps it next to the last tab, not against the strip's end.
    expect(add.previousElementSibling).toBe(strip.querySelector('[role="tablist"]'));
    expect(store.getSnapshot().layout.right.groups[0]!.panels).not.toContain("terminal");

    fireEvent.click(add);
    const items = () => [...document.querySelectorAll<HTMLButtonElement>('[data-dock-menu="popup"] [role="menuitem"]')];
    const terminal = items().find(node => node.textContent?.trim().startsWith("Terminal"))!;
    expect(terminal).toBeDefined();
    // The menu only offers tabs this group does not already hold.
    expect(items().some(node => node.textContent?.trim().startsWith("Changes"))).toBe(false);

    fireEvent.click(terminal);
    const right = store.getSnapshot().layout.right.groups[0]!;
    expect(right.panels).toContain("terminal");
    expect(right.active).toBe("terminal");
    expect(store.getSnapshot().layout.bottom.groups[0]!.panels).not.toContain("terminal");
  });

  it("opens tab and group actions from right-click or the keyboard without a More button", () => {
    const { float } = setup();
    const strip = document.querySelector<HTMLElement>('.dock-group-region-right .dock-tab-strip')!;
    const tab = strip.querySelector<HTMLButtonElement>('[role="tab"]')!;
    const item = (en: string, zh: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-dock-menu="popup"] [role="menuitem"]')].find(node => [en, zh].includes(node.textContent?.trim() ?? ""))!;
    expect(strip.querySelector('.dock-menu-button:not(.dock-tab-add)')).toBeNull();
    fireEvent.contextMenu(tab, { clientX: 100, clientY: 70 });
    expect(document.querySelectorAll('[data-dock-menu="popup"]')).toHaveLength(1);
    fireEvent.click(item("Tab group", "标签组"));
    expect(item("Add tool", "添加工具")).toBeDefined();
    expect(item("Hide right sidebar", "隐藏右侧栏")).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); flush();
    expect(document.activeElement).toBe(tab);
    fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
    expect(document.querySelectorAll('[data-dock-menu="popup"]')).toHaveLength(1);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); flush();
    fireEvent.contextMenu(strip, { clientX: 200, clientY: 70 });
    expect(item("Add tool", "添加工具")).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); flush();
    const header = float().querySelector<HTMLElement>('.dock-float-titlebar')!;
    fireEvent.keyDown(header, { key: "ContextMenu" });
    expect(item("Move group to", "整组移动到")).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); flush();
    expect(document.activeElement).toBe(header);
    fireEvent.contextMenu(float().querySelector('.dock-group-body')!);
    expect(document.querySelector('[data-dock-menu="popup"]')).toBeNull();
  });
});

describe("conversation rail", () => {
  it("commits a mode switch even when snapshot capture is suspended", async () => {
    geometry();
    vi.useFakeTimers();
    const transitions: { update: () => void; skipTransition: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: (update: () => void) => {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const skipTransition = vi.fn(finish);
      transitions.push({ update, skipTransition, finish });
      return { ready: new Promise<void>(() => {}), finished, skipTransition };
    } });
    try {
      const store = new DockStore(null);
      store.dispatch({ type: "card", panel: "agents", collapsed: false });
      store.dispatch({ type: "railMode", mode: "expanded" });
      function Surface() {
        const { layout } = useDock();
        return <><div className="adaptive-workbench"><div className="convo-wrap"><DockRail mode={layout.rail.mode} /></div></div><DockPanel id="agents"><input aria-label="animated draft" defaultValue="keep" /></DockPanel></>;
      }
      render(<DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider>);
      flush(); flush();
      const input = document.querySelector<HTMLInputElement>('[aria-label="animated draft"]')!;
      input.value = "edited";
      const toggle = () => document.querySelector<HTMLButtonElement>(".dock-rail-toolbar > button:nth-of-type(2)")!;
      fireEvent.click(toggle());
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(store.getSnapshot().layout.rail.mode).toBe("compact");
      expect(transitions[0]!.skipTransition).toHaveBeenCalledOnce();
      expect(document.documentElement.hasAttribute("data-dock-rail-transition")).toBe(false);
      fireEvent.click(toggle());
      act(() => transitions[1]!.update());
      flush(); flush();
      act(() => transitions[0]!.update());
      expect(store.getSnapshot().layout.rail.mode).toBe("expanded");
      expect(document.querySelector('[aria-label="animated draft"]')).toBe(input);
      expect(input.value).toBe("edited");
      await act(async () => transitions[1]!.finish());
      expect(document.documentElement.hasAttribute("data-dock-rail-transition")).toBe(false);
      act(() => store.dispatch({ type: "move", panels: ["logs"], target: { region: "rail" } }));
      flush(); flush();
      const title = (id: string) => document.querySelector<HTMLButtonElement>(`.dock-rail-expanded [data-dock-card="${id}"] .dock-card-title`)!;
      fireEvent.click(title("agents"));
      fireEvent.click(title("logs"));
      expect(store.getSnapshot().layout.cards.agents.collapsed).toBe(true);
      act(() => transitions[3]!.update());
      expect(store.getSnapshot().layout.cards.logs.collapsed).toBe(true);
      await act(async () => transitions[3]!.finish());
      fireEvent.click(title("agents"));
      fireEvent.click(title("agents"));
      act(() => transitions[5]!.update());
      expect(store.getSnapshot().layout.cards.agents.collapsed).toBe(true);
      await act(async () => transitions[5]!.finish());
      expect(document.documentElement.hasAttribute("data-dock-rail-transition")).toBe(false);
    } finally {
      delete (document as Partial<Document>).startViewTransition;
      vi.useRealTimers();
    }
  });

  it("opens compact tools and retains drafts when switching the rail mode", () => {
    geometry();
    const store = new DockStore(null);
    store.dispatch({ type: "card", panel: "agents", collapsed: false });
    store.dispatch({ type: "railMode", mode: "compact" });
    function Surface() {
      const { layout } = useDock();
      return <><div className="adaptive-workbench"><div className="convo-wrap"><DockRail mode={layout.rail.mode} /></div></div><DockPanel id="agents"><input aria-label="agent draft" defaultValue="keep" /></DockPanel></>;
    }
    render(<DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider>);
    flush(); flush();
    const icon = () => document.querySelector<HTMLButtonElement>('[data-dock-rail-icon="agents"]')!;
    fireEvent.click(icon()); flush(); flush();
    const input = document.querySelector<HTMLInputElement>('[aria-label="agent draft"]')!;
    input.value = "edited";
    expect(icon().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" }); flush();
    expect(icon().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(icon());
    fireEvent.click(document.querySelector<HTMLButtonElement>(".dock-rail-toolbar > button:nth-of-type(2)")!); flush(); flush();
    expect(store.getSnapshot().layout.rail.mode).toBe("expanded");
    expect(document.querySelector('[aria-label="agent draft"]')).toBe(input);
    expect(input.value).toBe("edited");
    const title = () => document.querySelector<HTMLButtonElement>('.dock-rail-expanded [data-dock-card="agents"] .dock-card-title')!;
    fireEvent.click(title()); flush(); flush();
    expect(title().getAttribute("aria-expanded")).toBe("false");
    expect(input.closest<HTMLElement>('[data-panel]')?.hidden).toBe(true);
    fireEvent.click(title()); flush(); flush();
    expect(title().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[aria-label="agent draft"]')).toBe(input);
    expect(input.value).toBe("edited");
    fireEvent.click(document.querySelector<HTMLButtonElement>(".dock-rail-toolbar > button:nth-of-type(2)")!); flush();
    fireEvent.click(icon()); flush(); flush();
    expect(document.querySelector('[aria-label="agent draft"]')).toBe(input);
    expect(input.value).toBe("edited");
    fireEvent.click(document.querySelector<HTMLButtonElement>(".dock-rail-toolbar > button:last-child")!); flush();
    expect(store.getSnapshot().layout.rail.mode).toBe("hidden");
    expect(document.querySelector(".dock-rail-compact, .dock-rail-expanded")).toBeNull();
  });
});

describe("live dock drag", () => {
  function setup(partial = false, left = false) {
    geometry();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".adaptive-workbench")) return new DOMRect(60, 50, 1400, 900);
      if (this.matches(".sidebar")) return new DOMRect(60, 50, 272, 900);
      if (this.matches("#sbProjects")) return new DOMRect(60, 150, 272, 750);
      if (this.matches(".sb-footer")) return new DOMRect(60, 900, 272, 50);
      const preview = this.closest<HTMLElement>(".dock-drag-preview");
      if (preview) {
        const x = Number.parseFloat(preview.style.left), y = Number.parseFloat(preview.style.top);
        const w = Number.parseFloat(preview.style.width), h = Number.parseFloat(preview.style.height);
        return this.matches(".dock-slot, .dock-group-body") ? new DOMRect(x, y + 70, w, h - 70) : new DOMRect(x, y, w, h);
      }
      const floating = this.closest<HTMLElement>(".dock-float");
      if (floating) {
        const x = Number.parseFloat(floating.style.left), y = Number.parseFloat(floating.style.top);
        const w = Number.parseFloat(floating.style.width), h = Number.parseFloat(floating.style.height);
        return this.matches(".dock-slot, .dock-group-body") ? new DOMRect(x, y + 70, w, h - 70) : new DOMRect(x, y, w, h);
      }
      return new DOMRect(60, 50, 400, 280);
    });
    const store = new DockStore(null);
    store.dispatch({ type: "open", panel: "changes" });
    store.dispatch({ type: "move", panels: partial ? ["files", "git"] : ["files"], target: { region: "float", rect: { x: 0, y: 0, width: 560, height: 400 } } });
    let hosts!: PanelHosts;
    const mounted = vi.fn(), unmounted = vi.fn();
    function Body() { useEffect(() => { mounted(); return unmounted; }, []); return <input aria-label="live draft" defaultValue="keep" />; }
    function Surface() {
      hosts = useDockEngine().hosts;
      const { layout } = useDock();
      return <><div className="adaptive-workbench">{left && <aside className="sidebar"><section id="sbProjects">Projects</section><div id="sbDivider" style={{ height: 9 }} hidden />{layout.left.panels.length > 0 && <div className="dock-left-cards"><DockCardRegion region="left" /></div>}<footer className="sb-footer" /></aside>}<DockGroupRegion region="right" visible /></div><DockFloatingLayer /><DockPanel id="files"><Body /></DockPanel><DockPanel id="git"><p>Remaining Git panel</p></DockPanel></>;
    }
    const view = render(<DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider>);
    flush(); flush();
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [] });
    const input = document.querySelector<HTMLInputElement>('[aria-label="live draft"]')!;
    input.value = "edited";
    const host = hosts.get("files").element;
    host.scrollTop = 37;
    const source = document.querySelector<HTMLElement>(partial ? '.dock-float [data-dock-tab="files"] [role="tab"]' : ".dock-float-titlebar")!;
    const start = store.getSnapshot().layout;
    const move = (x: number, y: number) => { fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y }); flush(); };
    fireEvent.pointerDown(source, { pointerId: 1, button: 0, clientX: 70, clientY: 60 });
    return { store, hosts, input, host, source, start, move, mounted, unmounted, view };
  }

  it("moves the same live content in the same frame and commits only on drop", () => {
    const { store, input, host, start, move, mounted, unmounted } = setup();
    move(110, 100);
    expect(document.querySelector('.dock-drag-preview .dock-tab-strip')).toBeNull();
    expect(host.style.left).toBe("100px");
    expect(host.style.top).toBe("160px");
    move(190, 160);
    expect(host.style.left).toBe("180px");
    expect(host.style.top).toBe("220px");
    expect(document.querySelector(".dock-floating-layer > .dock-float")?.classList.contains("dock-drag-source")).toBe(true);
    expect(store.getSnapshot().layout).toBe(start);
    expect(document.querySelectorAll('[data-panel="files"]')).toHaveLength(1);
    expect(document.querySelector('[aria-label="live draft"]')).toBe(input);
    expect(input.value).toBe("edited");
    expect(host.scrollTop).toBe(37);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 210, clientY: 180 });
    expect(store.getSnapshot().layout.floats[0]!.rect).toMatchObject({ x: 140, y: 120 });
    expect(host.style.left).toBe("200px");
    expect(host.style.top).toBe("240px");
    expect(document.querySelector(".dock-drag-preview, .dock-drag-source")).toBeNull();
    expect(host.classList.contains("is-drag-preview")).toBe(false);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it.each([false, true])("previews live content at the left sidebar bottom and commits on drop (group: %s)", partial => {
    const { store, input, host, start, move, mounted, unmounted } = setup(partial, true);
    move(200, 200);
    const preview = dragPreview.snapshot()!;
    expect(preview.target).toEqual({ region: "left" });
    expect(preview.rect.x).toBe(60);
    expect(preview.rect.y).toBeCloseTo(499.86);
    expect(preview.rect.width).toBe(272);
    expect(preview.rect.height).toBeCloseTo(400.14);
    expect(document.querySelector('[aria-label="live draft"]')).toBe(input);
    expect(host.classList.contains("is-drag-preview")).toBe(true);
    expect(host.style.left).toBe("60px");
    expect(host.scrollTop).toBe(37);
    expect(store.getSnapshot().layout).toBe(start);

    move(200, 400);
    expect(dragPreview.snapshot()!.rect).toEqual(preview.rect);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true }); flush();
    expect(dragPreview.snapshot()!.target.region).toBe("float");
    fireEvent.keyUp(window, { key: "Control", ctrlKey: false }); flush();
    expect(dragPreview.snapshot()!.target.region).toBe("left");
    move(500, 400);
    expect(dragPreview.snapshot()!.target.region).toBe("float");
    move(200, 200);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 200 });
    expect(store.getSnapshot().layout.left.panels).toEqual(["files"]);
    expect(document.querySelector('[data-panel="files"]')).toBe(host);
    expect(input.value).toBe("edited");
    expect(host.scrollTop).toBe(37);
    expect(dragPreview.snapshot()).toBeNull();
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("interrupts a snap animation without queuing motion or losing the live body", () => {
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    try {
      const { store, host, input, start, move } = setup(false, true);
      move(500, 300);
      expect(animate).not.toHaveBeenCalled();
      move(200, 200);
      expect(animate).toHaveBeenCalledOnce();
      move(200, 250);
      expect(animate).toHaveBeenCalledOnce();
      fireEvent.keyDown(window, { key: "Control", ctrlKey: true }); flush();
      expect(animations[0]!.cancel).toHaveBeenCalledOnce();
      expect(animate).toHaveBeenCalledOnce();
      move(700, 400);
      move(1000, 600);
      expect(animate).toHaveBeenCalledOnce();
      expect(store.getSnapshot().layout).toBe(start);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(animations[0]!.cancel).toHaveBeenCalledOnce();
      flush();
      expect(document.querySelector(".dock-drag-preview")).toBeNull();
      expect(host.classList.contains("is-drag-preview")).toBe(false);
      expect(document.querySelector('[aria-label="live draft"]')).toBe(input);
      expect(input.value).toBe("edited");
      expect(store.getSnapshot().layout).toBe(start);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("finishes the snap curve after an early drop while committing layout immediately", () => {
    const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => animation });
    try {
      const { store, host, input, move } = setup(false, true);
      move(500, 300);
      move(200, 200);
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(store.getSnapshot().layout.left.panels).toEqual(["files"]);
      expect(dragPreview.snapshot()?.settling).toBe(true);
      expect(animation.cancel).not.toHaveBeenCalled();
      expect(document.querySelector('[data-panel="files"]')).toBe(host);
      act(() => animation.onfinish?.());
      flush();
      expect(document.querySelector(".dock-drag-preview")).toBeNull();
      expect(host.classList.contains("is-drag-preview")).toBe(false);
      expect(document.querySelector('[aria-label="live draft"]')).toBe(input);
      expect(input.value).toBe("edited");
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("does not restart a landing animation for subpixel layout rounding", () => {
    const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
    const animate = vi.fn(() => animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    try {
      const { move } = setup(false, true);
      move(200, 200);
      const preview = dragPreview.snapshot()!;
      for (const delta of [0.00002, -0.00002, 0.00001]) {
        act(() => dragPreview.show({ ...preview, rect: { ...preview.rect, y: preview.rect.y + delta } }));
      }
      expect(animate).toHaveBeenCalledOnce();
      expect(animation.cancel).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: "Escape" });
    } finally { delete (HTMLElement.prototype as Partial<HTMLElement>).animate; }
  });

  it("keeps a fast exit under the pointer and hands back the same host on release", () => {
    const { store, host, input, move } = setup(false, true);
    move(200, 200);
    move(800, 400);
    const preview = document.querySelector<HTMLElement>(".dock-drag-preview")!;
    expect(preview.style.transform).toBe("");
    expect(preview.style.left).toBe("790px");
    expect(preview.style.top).toBe("390px");
    move(1100, 600);
    expect(preview.style.left).toBe("900px");
    expect(preview.style.top).toBe("550px");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1100, clientY: 600 });
    expect(store.getSnapshot().layout.floats[0]!.rect).toMatchObject({ x: 840, y: 500 });
    expect(dragPreview.snapshot()).toBeNull();
    expect(host.classList.contains("is-drag-preview")).toBe(false);
    expect(document.querySelector('[data-panel="files"]')).toBe(host);
    expect(document.querySelector('[aria-label="live draft"]')).toBe(input);
    expect(input.value).toBe("edited");
    expect(host.scrollTop).toBe(37);
  });

  it("keeps a card dragged out of the sidebar under the pointer and cancels cleanly", () => {
    const { store, host, input } = setup(false, true);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => store.dispatch({ type: "move", panels: ["files"], target: { region: "left" } }));
    flush();
    const start = store.getSnapshot().layout;
    const source = document.querySelector<HTMLElement>('.sidebar [data-dock-card="files"] .dock-card-header')!;
    fireEvent.pointerDown(source, { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 950, clientY: 500 }); flush();
    const preview = document.querySelector<HTMLElement>(".dock-drag-preview")!;
    expect(preview.style.transform).toBe("");
    expect(preview.style.left).toBe("790px");
    expect(preview.style.top).toBe("482px");
    expect(store.getSnapshot().layout).toBe(start);
    fireEvent.keyDown(window, { key: "Escape" });
    flush();
    expect(document.querySelector(".dock-drag-preview")).toBeNull();
    expect(host.classList.contains("is-drag-preview")).toBe(false);
    expect(document.querySelector('[data-panel="files"]')).toBe(host);
    expect(document.querySelector('[aria-label="live draft"]')).toBe(input);
    expect(store.getSnapshot().layout).toBe(start);
  });

  it("stops scheduling drag updates when a tab strip cannot scroll further", () => {
    const { move } = setup();
    const strip = document.querySelector<HTMLElement>('.dock-group-region-right .dock-tabs')!;
    Object.defineProperty(strip, "scrollLeft", { configurable: true, get: () => 0, set: () => {} });
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [strip] });
    const listener = vi.fn();
    const release = dragPreview.subscribe(listener);
    move(70, 100);
    const updates = listener.mock.calls.length;
    for (let index = 0; index < 4; index++) flush();
    expect(listener).toHaveBeenCalledTimes(updates);
    fireEvent.keyDown(window, { key: "Escape" });
    release();
  });

  it("restores the same live host when cancelling a left snap", () => {
    const { store, host, input, start, move } = setup(false, true);
    move(200, 200);
    expect(dragPreview.snapshot()!.target.region).toBe("left");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(store.getSnapshot().layout).toBe(start);
    expect(host.classList.contains("is-drag-preview")).toBe(false);
    expect(host.style.left).toBe("60px");
    expect(host.style.top).toBe("120px");
    expect(document.querySelector('[aria-label="live draft"]')).toBe(input);
    expect(host.scrollTop).toBe(37);
  });

  it("keeps the remaining tool visible while detaching one active tab", () => {
    const { store, host, start, move, hosts } = setup(true);
    move(500, 300);
    const source = document.querySelector<HTMLElement>(".dock-floating-layer > .dock-float")!;
    expect(source.classList.contains("dock-drag-source")).toBe(false);
    expect(source.querySelector('[data-dock-tab="files"]')?.classList.contains("dock-drag-source")).toBe(true);
    expect(source.querySelector('[data-dock-slot="git"]')).not.toBeNull();
    expect(hosts.get("git").element.hidden).toBe(false);
    expect(host.classList.contains("is-drag-preview")).toBe(true);
    expect(store.getSnapshot().layout).toBe(start);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(source.querySelector('[data-dock-slot="files"]')).not.toBeNull();
    expect(source.querySelector(".dock-drag-source")).toBeNull();
    expect(host.classList.contains("is-drag-preview")).toBe(false);
    expect(store.getSnapshot().layout).toBe(start);
  });

  it.each(["escape", "pointercancel", "blur", "scope", "unmount"])("clears transient ownership on %s", reason => {
    const { store, host, start, move, view } = setup();
    move(190, 160);
    if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "pointercancel") fireEvent.pointerCancel(window, { pointerId: 1 });
    else if (reason === "blur") fireEvent(window, new Event("blur"));
    else if (reason === "scope") act(() => store.switchScope({ target: "local", project: null, session: "other" }, false));
    else view.unmount();
    expect(dragPreview.snapshot()).toBeNull();
    expect(document.querySelector(".dock-drag-preview, .dock-drag-source")).toBeNull();
    expect(document.body.classList.contains("dock-dragging")).toBe(false);
    if (reason !== "scope" && reason !== "unmount") {
      expect(store.getSnapshot().layout).toBe(start);
      expect(host.style.left).toBe("60px");
      expect(host.style.top).toBe("120px");
    }
    const after = store.getSnapshot().layout;
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 500, clientY: 300 }); flush();
    expect(store.getSnapshot().layout).toBe(after);
  });
});

describe("dock pointer protocol", () => {
  function setup() {
    geometry();
    const store = new DockStore(null);
    function Surface() {
      const { hosts } = useDockEngine();
      return <div className="adaptive-workbench"><header data-testid="source" onPointerDown={event => beginDockDrag(event, store, ["files"], undefined, hosts)}>Files</header><div data-dock-entry="right">Right</div></div>;
    }
    render(<DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider>);
    const source = document.querySelector("header")!;
    const target = document.querySelector('[data-dock-entry]')!;
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [target] });
    return { store, source };
  }
  it("previews hidden shared regions within their actual workbench area", () => {
    geometry();
    render(<div data-dock-workbench><div className="cw-navigation-slot" /><div className="cw-shell-main"><div className="cw-workbench"><div className="cw-right-slot" /></div></div></div>);
    const box = (selector: string, rect: DOMRect) => { document.querySelector<HTMLElement>(selector)!.getBoundingClientRect = vi.fn(() => rect); };
    box("[data-dock-workbench]", new DOMRect(0, 36, 1600, 964));
    box(".cw-navigation-slot", new DOMRect(0, 36, 56, 964));
    box(".cw-shell-main", new DOMRect(328, 36, 1272, 964));
    box(".cw-workbench", new DOMRect(328, 80, 1272, 884));
    box(".cw-right-slot", new DOMRect(1600, 80, 0, 884));
    const layout = createDefaultLayout();
    const entry = new DOMRect(1300, 40, 32, 32);
    expect(previewBounds({ target: { region: "right" }, rect: entry, label: "" }, layout, ["output"])).toEqual({ x: 1120, y: 80, width: 480, height: 884 });
    expect(previewBounds({ target: { region: "bottom" }, rect: entry, label: "" }, layout, ["output"])).toEqual({ x: 328, y: 760, width: 1272, height: 240 });
  });
  it("accepts the whole visible left sidebar while retaining precise dock targets", () => {
    geometry();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".adaptive-workbench")) return new DOMRect(60, 50, 1400, 900);
      if (this.matches(".sidebar")) return new DOMRect(60, 50, 272, 900);
      return new DOMRect(60, 400, 272, 200);
    });
    render(<div className="adaptive-workbench"><aside className="sidebar"><section>Projects</section><div data-dock-cards="left"><section data-dock-card="files" /></div></aside><div data-dock-entry="right" /></div>);
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
    const card = document.querySelector<HTMLElement>('[data-dock-card="files"]')!;
    let elements: Element[] = [sidebar];
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => elements });
    for (const y of [70, 250, 750]) expect(dockHitTest(200, y, true)?.target).toEqual({ region: "left" });
    expect(dockHitTest(200, 70, false)?.target.region).toBe("float");
    expect(dockHitTest(350, 70, true)?.target.region).toBe("float");
    elements = [card];
    expect(dockHitTest(200, 450, true)?.target).toEqual({ region: "left", index: 0 });
    elements = [document.querySelector('[data-dock-entry="right"]')!];
    expect(dockHitTest(200, 450, true)?.target.region).toBe("right");
    elements = [];
    sidebar.classList.add("collapsed");
    expect(dockHitTest(200, 70, true)?.target.region).toBe("float");
    sidebar.classList.remove("collapsed");
    sidebar.setAttribute("inert", "");
    expect(dockHitTest(200, 70, true)?.target.region).toBe("float");
    sidebar.removeAttribute("inert");
    document.querySelector<HTMLElement>(".adaptive-workbench")!.hidden = true;
    expect(dockHitTest(200, 70, true)?.target.region).toBe("float");
  });

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

  it("gives every tool instance its own body and keeps their drafts apart", () => {
    geometry();
    const store = new DockStore(null);
    render(<DockProvider definitions={WORKBENCH_PANELS} store={store}>
      <div className="adaptive-workbench">
        <div><DockSlot id="files" /></div>
        <div><DockSlot id="files@2" /></div>
      </div>
      <PanelInstances base="files">{id => <input aria-label={`draft ${id}`} defaultValue="" />}</PanelInstances>
    </DockProvider>);
    flush(); flush();
    const primary = document.querySelector<HTMLInputElement>('[aria-label="draft files"]')!;
    fireEvent.change(primary, { target: { value: "left" } });
    act(() => store.openIn("files", { region: "right" }));
    flush(); flush();
    const second = document.querySelector<HTMLInputElement>('[aria-label="draft files@2"]')!;
    expect(second).not.toBe(primary);
    expect(primary.isConnected).toBe(true);
    fireEvent.change(second, { target: { value: "right" } });
    expect(primary.value).toBe("left");
    expect(document.querySelectorAll('[data-panel="files"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-panel="files@2"]')).toHaveLength(1);
  });

  it("registers the same body for a tool's extra instance", () => {
    geometry();
    const store = new DockStore(null);
    store.dispatch({ type: "open", panel: "changes" });
    render(<DockProvider definitions={WORKBENCH_PANELS} store={store}>
      <div className="adaptive-workbench">
        <div><DockSlot id="changes" /></div>
        <div><DockSlot id="changes@2" /></div>
      </div>
      <PanelRegistration panels={{ changes: <input aria-label="changes body" /> }} />
    </DockProvider>);
    flush(); flush();
    act(() => store.openIn("changes", { region: "left" }));
    flush(); flush();
    expect(document.querySelectorAll('[data-panel="changes@2"]')).toHaveLength(1);
    expect(document.querySelectorAll('input[aria-label="changes body"]')).toHaveLength(2);
  });
});
