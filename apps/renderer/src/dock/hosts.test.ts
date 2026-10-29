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

describe("dock wheel handoff", () => {
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
