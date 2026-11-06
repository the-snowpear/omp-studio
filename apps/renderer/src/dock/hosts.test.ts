import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHosts } from "./hosts";

type Metrics = { clientHeight: number; scrollHeight: number; clientWidth?: number; scrollWidth?: number };
type ScrollState = { scrollTop: number; scrollLeft: number };

/** jsdom has no layout, so give an element the scroll geometry the plan reads. */
function scrollBox(element: HTMLElement, metrics: Metrics): ScrollState {
  const state: ScrollState = { scrollTop: 0, scrollLeft: 0 };
  const values = { clientWidth: 400, scrollWidth: 400, ...metrics };
  for (const key of ["clientHeight", "scrollHeight", "clientWidth", "scrollWidth"] as const) Object.defineProperty(element, key, { configurable: true, value: values[key] });
  for (const key of ["scrollTop", "scrollLeft"] as const) Object.defineProperty(element, key, { configurable: true, get: () => state[key], set: (value: number) => { state[key] = value; } });
  return state;
}

function enableRailMoves(slot: HTMLElement): void {
  Object.defineProperty(slot, "moveBefore", { configurable: true, value: (node: Node, before: Node | null) => slot.insertBefore(node, before) });
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const WORKBENCH_CARD = `
  <main class="adaptive-workbench">
    <div class="dock-card-region dock-card-region-left">
      <div class="dock-card-list" data-dock-cards="left">
        <section class="dock-card" data-dock-card="files">
          <div class="dock-card-body"><div class="dock-slot" data-dock-slot="files"></div></div>
        </section>
      </div>
    </div>
  </main>
  <div class="dock-host-layer"></div>`;

/** One Files card in the left card column, its fixed body host, and a streamed child. */
function fixture() {
  document.body.innerHTML = WORKBENCH_CARD;
  const layer = document.querySelector<HTMLElement>(".dock-host-layer")!;
  const slot = document.querySelector<HTMLElement>('[data-dock-slot="files"]')!;
  const list = document.querySelector<HTMLElement>(".dock-card-list")!;
  list.style.overflowY = "auto";
  const column = scrollBox(list, { clientHeight: 400, scrollHeight: 2000 });
  const hosts = new PanelHosts();
  const host = hosts.get("files");
  layer.append(host.element);
  host.element.style.overflowY = "auto";
  const body = scrollBox(host.element, { clientHeight: 300, scrollHeight: 1000 });
  const pane = document.createElement("div");
  pane.textContent = "streamed body";
  host.element.append(pane);
  const detach = hosts.attach(layer);
  const release = hosts.slot("files", slot);
  cleanups.push(() => { release(); detach(); });
  return { hosts, host, layer, slot, list, column, body, pane, release, detach };
}

function wheel(target: EventTarget, init: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("floating body corners", () => {
  it("follows the floating and maximized state of the window that owns its slot", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 300, 200));
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(100, 50, 300, 200)] as unknown as DOMRectList);
    const { hosts, host, slot } = fixture();
    const floating = document.createElement("section");
    floating.dataset.dockFloat = "test-float";
    floating.append(slot);
    document.body.append(floating);
    hosts.flush();
    expect(host.element.dataset.dockRegion).toBe("float");
    expect(host.element.hasAttribute("data-dock-maximized")).toBe(false);
    floating.classList.add("is-maximized"); hosts.flush();
    expect(host.element.hasAttribute("data-dock-maximized")).toBe(true);
    floating.classList.remove("is-maximized"); hosts.flush();
    expect(host.element.hasAttribute("data-dock-maximized")).toBe(false);
  });

  it("matches rail card corners while preserving scroll clipping and clears them after moving", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".dock-card, .dock-rail-overlay")) return new DOMRect(100, 0, 300, 257);
      if (this.dataset.dockSlot === "files") return new DOMRect(100, 50, 300, 200);
      if (this.classList.contains("dock-card-list")) return new DOMRect(0, 0, 500, 120);
      return new DOMRect(0, 0, 2000, 2000);
    });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(100, 50, 300, 200)] as unknown as DOMRectList);
    const { hosts, host, slot, list } = fixture();
    list.dataset.dockCards = "rail";
    const card = slot.closest<HTMLElement>(".dock-card")!;
    card.parentElement!.parentElement!.classList.add("dock-card-region-rail");
    card.style.border = "1px solid black"; card.style.borderBottomLeftRadius = card.style.borderBottomRightRadius = "16px";
    hosts.flush();
    // The viewport currently cuts off the rounded part of the card entirely.
    expect(host.element.getAttribute("style")).toContain("clip-path:inset(0px 0px 130px 0px)");
    list.style.overflowY = "visible";
    hosts.flush();
    expect(host.element.style.clipPath).toContain("polygon(");
    expect(host.element.style.clipPath).toContain("297px 200px, 3px 200px");

    const overlay = document.createElement("section");
    overlay.className = "dock-rail-overlay"; overlay.dataset.dockCards = "rail";
    overlay.style.border = "1px solid black"; overlay.style.borderBottomLeftRadius = overlay.style.borderBottomRightRadius = "16px";
    overlay.append(slot); document.body.append(overlay);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 300, 251));
    hosts.flush();
    expect(host.element.style.clipPath).toContain("polygon(");
    expect(host.element.style.clipPath).toContain("285px 200px, 15px 200px");

    document.querySelector(".adaptive-workbench")!.append(slot);
    hosts.flush();
    expect(host.element.style.clipPath).toContain("inset(");
  });
});

describe("dock wheel handoff", () => {
  it("keeps a fixed host when the browser cannot move live content without resetting it", () => {
    const { hosts, host, layer, slot, list, pane, body, column, release } = fixture();
    release();
    list.dataset.dockCards = "rail";
    list.parentElement!.className = "dock-card-region dock-card-region-rail";
    Object.defineProperty(slot, "moveBefore", { configurable: true, value: undefined });
    const releaseRail = hosts.slot("files", slot);
    cleanups.push(releaseRail);
    expect(host.element.parentElement).toBe(layer);
    body.scrollTop = 700;
    expect(wheel(pane).defaultPrevented).toBe(true);
    expect(column.scrollTop).toBe(100);
  });

  it("lets an expanded rail card and its list use the same native scroll chain", () => {
    const { hosts, host, slot, list, pane, body, release } = fixture();
    release();
    list.dataset.dockCards = "rail";
    list.parentElement!.className = "dock-card-region dock-card-region-rail";
    enableRailMoves(slot);
    const releaseRail = hosts.slot("files", slot);
    cleanups.push(releaseRail);
    expect(host.element.parentElement).toBe(slot);
    expect(host.element.hasAttribute("data-dock-embedded")).toBe(true);
    body.scrollTop = 700;
    // The browser, rather than the fixed-layer wheel handler, owns this event.
    expect(wheel(pane).defaultPrevented).toBe(false);
  });

  it("keeps nested wheel steps moving the rail after the inner scrollport reaches its edge", () => {
    const { hosts, host, slot, list, pane, body, column, release } = fixture();
    release();
    list.dataset.dockCards = "rail";
    list.parentElement!.className = "dock-card-region dock-card-region-rail";
    enableRailMoves(slot);
    const releaseRail = hosts.slot("files", slot);
    const detachWheel = hosts.attachRailScroll(list);
    cleanups.push(releaseRail, detachWheel);
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    inner.append(pane);
    host.element.append(inner);
    const nested = scrollBox(inner, { clientHeight: 100, scrollHeight: 500 });
    body.scrollTop = 700;
    expect(wheel(pane).defaultPrevented).toBe(false);
    expect(column.scrollTop).toBe(0);
    nested.scrollTop = 400;
    expect(wheel(pane).defaultPrevented).toBe(true);
    expect(wheel(pane).defaultPrevented).toBe(true);
    expect(column.scrollTop).toBe(200);
    expect(wheel(pane, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(pane, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(wheel(pane, { deltaX: 120, deltaY: 20 }).defaultPrevented).toBe(false);
    inner.style.overscrollBehaviorY = "contain";
    expect(wheel(pane).defaultPrevented).toBe(false);
  });

  it("preserves fractional trackpad movement when scroll offsets round to pixels", () => {
    const { hosts, host, slot, list, pane, body, column, release } = fixture();
    release();
    list.dataset.dockCards = "rail";
    list.parentElement!.className = "dock-card-region dock-card-region-rail";
    enableRailMoves(slot);
    const releaseRail = hosts.slot("files", slot);
    const detachWheel = hosts.attachRailScroll(list);
    cleanups.push(releaseRail, detachWheel);
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => column.scrollTop, set: (value: number) => { column.scrollTop = Math.round(value); } });
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    inner.append(pane);
    host.element.append(inner);
    const nested = scrollBox(inner, { clientHeight: 100, scrollHeight: 500 });
    nested.scrollTop = 400;
    body.scrollTop = 700;
    for (let i = 0; i < 4; i++) wheel(pane, { deltaY: 0.25 });
    expect(column.scrollTop).toBe(1);
  });

  it("keeps the same rail body when borrowing it for a drag preview", () => {
    const { hosts, host, layer, slot, list, pane, body, release } = fixture();
    release();
    list.dataset.dockCards = "rail";
    list.parentElement!.className = "dock-card-region dock-card-region-rail";
    enableRailMoves(slot);
    const releaseRail = hosts.slot("files", slot);
    cleanups.push(releaseRail);
    body.scrollTop = 37;
    const preview = document.createElement("div");
    document.body.append(preview);
    const releasePreview = hosts.previewSlot("files", preview);
    expect(host.element.parentElement).toBe(layer);
    expect(host.element.hasAttribute("data-dock-embedded")).toBe(false);
    releasePreview();
    expect(host.element.parentElement).toBe(slot);
    expect(host.element.contains(pane)).toBe(true);
    expect(body.scrollTop).toBe(37);
    releaseRail();
    expect(host.element.parentElement).toBe(layer);
  });

  it("restores the body and inner scroll positions after a rail card is reopened", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 300));
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 300, 300)] as unknown as DOMRectList);
    const { hosts, host, slot, list, body, release } = fixture();
    release();
    list.dataset.dockCards = "rail";
    list.parentElement!.className = "dock-card-region dock-card-region-rail";
    enableRailMoves(slot);
    const inner = document.createElement("div");
    host.element.append(inner);
    const nested = scrollBox(inner, { clientHeight: 100, scrollHeight: 500 });
    const releaseRail = hosts.slot("files", slot);
    hosts.flush();
    body.scrollTop = 37;
    nested.scrollTop = 54;
    releaseRail();
    hosts.flush();
    // Browsers may clear offsets while moving a hidden scroll container.
    body.scrollTop = 0;
    nested.scrollTop = 0;
    const reopen = hosts.slot("files", slot);
    cleanups.push(reopen);
    hosts.flush();
    expect(body.scrollTop).toBe(37);
    expect(nested.scrollTop).toBe(54);
  });

  it("leaves the event to native scrolling while the body still has room", () => {
    const { pane, column, body } = fixture();
    const event = wheel(pane);
    expect(event.defaultPrevented).toBe(false);
    expect(column.scrollTop).toBe(0);
    expect(body.scrollTop).toBe(0);
  });

  it("scrolls the card column with the remainder at the body's bottom edge", () => {
    const { pane, column, body } = fixture();
    body.scrollTop = 700; // 1000 - 300
    const event = wheel(pane, { deltaY: 100 });
    expect(event.defaultPrevented).toBe(true);
    expect(column.scrollTop).toBe(100);
  });

  it("scrolls the card column upward at the body's top edge", () => {
    const { pane, column } = fixture();
    column.scrollTop = 300;
    const event = wheel(pane, { deltaY: -100 });
    expect(event.defaultPrevented).toBe(true);
    expect(column.scrollTop).toBe(200);
  });

  it("does nothing once the card column is at its own edge too", () => {
    const { pane, column, body } = fixture();
    body.scrollTop = 700;
    column.scrollTop = 1600; // 2000 - 400
    expect(wheel(pane).defaultPrevented).toBe(false);
    expect(column.scrollTop).toBe(1600);
  });

  it("ignores zoom, mostly-horizontal and already-consumed events", () => {
    const { pane, column, body } = fixture();
    body.scrollTop = 700;
    expect(wheel(pane, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(pane, { metaKey: true }).defaultPrevented).toBe(false);
    expect(wheel(pane, { deltaX: 120, deltaY: 20 }).defaultPrevented).toBe(false);
    const consumed = (event: Event) => event.preventDefault();
    pane.addEventListener("wheel", consumed);
    wheel(pane);
    pane.removeEventListener("wheel", consumed);
    expect(column.scrollTop).toBe(0);
  });

  it("converts line and page deltas before handing them over", () => {
    const { pane, column, body } = fixture();
    body.scrollTop = 700;
    wheel(pane, { deltaY: 3, deltaMode: 1 });
    expect(column.scrollTop).toBe(48);
    column.scrollTop = 0;
    wheel(pane, { deltaY: 1, deltaMode: 2 }); // one page of the body viewport
    expect(column.scrollTop).toBe(300);
  });

  it("lets a nested scroller consume first, then the body, then the column", () => {
    const { host, pane, column, body } = fixture();
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    inner.append(pane);
    host.element.append(inner);
    const nested = scrollBox(inner, { clientHeight: 100, scrollHeight: 500 });
    wheel(pane);
    expect(column.scrollTop).toBe(0);
    nested.scrollTop = 400; // the inner pane is done, the body still has room
    wheel(pane);
    expect(column.scrollTop).toBe(0);
    body.scrollTop = 700; // both are done
    wheel(pane);
    expect(column.scrollTop).toBe(100);
  });

  it("resolves host -> slot per event, so a moved slot follows its new column", () => {
    const { hosts, pane, column, body, list } = fixture();
    const other = document.createElement("div");
    other.style.overflowY = "auto";
    const otherColumn = scrollBox(other, { clientHeight: 400, scrollHeight: 2000 });
    const moved = document.createElement("div");
    moved.className = "dock-slot";
    moved.dataset.dockSlot = "files";
    other.append(moved);
    document.querySelector(".adaptive-workbench")!.append(other);
    const release = hosts.slot("files", moved);
    cleanups.push(release);
    body.scrollTop = 700;
    expect(wheel(pane).defaultPrevented).toBe(true);
    expect(otherColumn.scrollTop).toBe(100);
    expect(column.scrollTop).toBe(0);
    expect(list.contains(moved)).toBe(false);
  });

  it("stops forwarding after the slot or the layer is released", () => {
    const { hosts, slot, pane, column, body, release, detach } = fixture();
    body.scrollTop = 700;
    release();
    expect(wheel(pane).defaultPrevented).toBe(false);
    expect(column.scrollTop).toBe(0);
    const again = hosts.slot("files", slot);
    expect(wheel(pane).defaultPrevented).toBe(true);
    expect(column.scrollTop).toBe(100);
    again();
    detach();
    column.scrollTop = 0;
    expect(wheel(pane).defaultPrevented).toBe(false);
    expect(column.scrollTop).toBe(0);
  });

  it("does nothing for a slot whose ancestors cannot scroll", () => {
    document.body.innerHTML = `
      <main class="adaptive-workbench">
        <div class="dock-group-region">
          <div class="dock-groups">
            <div class="dock-group" data-dock-group="right-main">
              <div class="dock-group-body"><div class="dock-slot" data-dock-slot="git"></div></div>
            </div>
          </div>
        </div>
      </main>
      <div class="dock-host-layer"></div>`;
    const layer = document.querySelector<HTMLElement>(".dock-host-layer")!;
    const slot = document.querySelector<HTMLElement>('[data-dock-slot="git"]')!;
    const hosts = new PanelHosts();
    const host = hosts.get("git");
    layer.append(host.element);
    host.element.style.overflowY = "auto";
    const body = scrollBox(host.element, { clientHeight: 300, scrollHeight: 1000 });
    const pane = document.createElement("div");
    host.element.append(pane);
    const detach = hosts.attach(layer);
    const release = hosts.slot("git", slot);
    cleanups.push(() => { release(); detach(); });
    body.scrollTop = 700;
    expect(wheel(pane).defaultPrevented).toBe(false);
  });

  it("keeps one stable host element and DOM node for a panel", () => {
    const { hosts, host, slot } = fixture();
    expect(hosts.get("files")).toBe(host);
    expect(document.querySelectorAll(".dock-panel-content")).toHaveLength(1);
    expect(document.querySelector('[data-panel="files"]')).toBe(host.element);
    expect(slot.closest(".dock-card-body")).not.toBeNull();
  });
});

describe("dock geometry observation", () => {
  it("positions and clips the body to its slot rect", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.dockSlot === "files") return new DOMRect(100, 50, 300, 200);
      // Only the card list is smaller than the slot, so it is what clips it.
      return this.classList.contains("dock-card-list") ? new DOMRect(0, 0, 500, 120) : new DOMRect(0, 0, 2000, 2000);
    });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(100, 50, 300, 200)] as unknown as DOMRectList);
    const { hosts, host } = fixture();
    const flush = () => { for (const fn of frames.splice(0)) fn(0); };
    flush();
    expect(host.element.hidden).toBe(false);
    expect(host.element.inert).toBe(false);
    const style = host.element.getAttribute("style");
    expect(style).toContain("left:100px;top:50px;width:300px;height:200px");
    expect(style).toContain("clip-path:inset(0px 0px 130px 0px)");
    // Same geometry on the next frame: no attribute is rewritten.
    host.element.setAttribute("style", "sentinel");
    hosts.schedule();
    flush();
    expect(host.element.getAttribute("style")).toBe("sentinel");
  });

  it("does not let an old toolbar cleanup release a newer preview owner", () => {
    const hosts = new PanelHosts();
    const host = hosts.get("files");
    const toolbar = document.createElement("span");
    const release = hosts.toolbar("files", toolbar);
    const old = hosts.previewToolbar("files", null);
    const current = hosts.previewToolbar("files", null);
    old();
    expect(host.toolbarSnapshot()).toBeNull();
    current();
    expect(host.toolbarSnapshot()).toBe(toolbar);
    release();
  });

  it("ignores panel-body mutations but still measures dock geometry changes", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { host, slot, pane } = fixture();
    const flush = () => { for (const fn of frames.splice(0)) fn(0); };
    flush(); // the initial attach() measure
    expect(frames).toHaveLength(0);
    // Streaming text and nodes inside the panel body must not re-measure hosts.
    pane.textContent = "more streamed text";
    pane.append(document.createElement("span"));
    expect(frames).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(frames).toHaveLength(0);
    // A slot resize is real dock geometry and must be picked up.
    slot.style.height = "180px";
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(frames.length).toBeGreaterThan(0);
    flush();
    expect(host.element.classList.contains("dock-panel-content")).toBe(true);
  });

  it("re-measures when a card body appears or disappears around a slot", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { host } = fixture();
    const flush = () => { for (const fn of frames.splice(0)) fn(0); };
    flush();
    // Collapsing a card removes its body, which moves every following slot.
    const body = host.element.ownerDocument.querySelector(".dock-card-body")!;
    body.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(frames.length).toBeGreaterThan(0);
  });
});
