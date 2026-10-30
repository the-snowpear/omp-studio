import { planScroll, readChain, scrollChain } from "./scrollChain";
import type { PanelId, PanelVisibility } from "./types";

type Host = { element: HTMLDivElement; visibility: PanelVisibility; listeners: Set<() => void>; subscribe: (listener: () => void) => () => void; snapshot: () => PanelVisibility; signature: string };
const EMPTY: PanelVisibility = { visible: false, width: 0, height: 0 };
const BODY = "dock-panel-content";
const BODY_SELECTOR = ".dock-panel-content";
/**
 * Every element whose mutation can move a slot rect: slots themselves, the
 * chrome around them, the workbench root (layout overlay, --dock-rail-w) and
 * floats (dragged/resized by writing inline styles). Panel bodies are excluded
 * on purpose - they are where streaming mutates every frame.
 */
const GEOMETRY = [
  "[data-dock-slot]", "[data-dock-cards]", "[data-dock-groups]", "[data-dock-region]", "[data-dock-group]", "[data-dock-float]", "[data-dock-entry]",
  ".dock-card-region", ".dock-card-list", ".dock-card", ".dock-card-body", ".dock-groups", ".dock-group-region", ".dock-group", ".dock-group-body",
  ".dock-left-cards", ".dock-rail-expanded", ".dock-rail-compact", ".dock-rail-overlay", ".dock-float", ".adaptive-workbench",
].join(", ");

/** One read/write batch owns all panel geometry, including clipping while cards scroll. */
export class PanelHosts {
  private hosts = new Map<PanelId, Host>();
  private slots = new Map<PanelId, HTMLElement>();
  private layer: HTMLElement | null = null;
  private observer: ResizeObserver | undefined;
  private mutations: MutationObserver | undefined;
  private frame = 0;
  get(id: PanelId): Host {
    let host = this.hosts.get(id);
    if (!host) {
      const element = document.createElement("div");
      element.className = BODY;
      element.dataset.panel = id;
      element.inert = true;
      element.hidden = true;
      host = { element, visibility: EMPTY, listeners: new Set(), subscribe: listener => { host!.listeners.add(listener); return () => { host!.listeners.delete(listener); }; }, snapshot: () => host!.visibility, signature: "0|" };
      this.hosts.set(id, host);
      this.layer?.append(element);
    }
    return host;
  }
  attach(layer: HTMLElement) {
    this.layer = layer;
    for (const host of this.hosts.values()) layer.append(host.element);
    this.observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(this.schedule);
    this.observer?.observe(document.documentElement);
    for (const slot of this.slots.values()) this.observer?.observe(slot);
    this.mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(this.changed);
    // Observing all of document.body measured every panel on every streaming
    // frame. Only dock chrome and slot geometry can move a host; `changed`
    // drops panel bodies, which is where the streaming mutations happen.
    this.mutations?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "inert", "data-layout-overlay", "style"] });
    // Native scrolling cannot chain from the fixed host layer into the card
    // column, so this one layer-level listener performs that handoff.
    layer.addEventListener("wheel", this.wheel, { passive: false });
    document.addEventListener("scroll", this.schedule, true);
    window.addEventListener("resize", this.schedule);
    this.schedule();
    return () => {
      layer.removeEventListener("wheel", this.wheel);
      this.observer?.disconnect(); this.mutations?.disconnect();
      this.observer = this.mutations = undefined;
      document.removeEventListener("scroll", this.schedule, true);
      window.removeEventListener("resize", this.schedule);
      cancelAnimationFrame(this.frame); this.frame = 0; this.layer = null;
    };
  }
  slot(id: PanelId, node: HTMLElement) {
    this.slots.set(id, node); this.observer?.observe(node); this.schedule();
    return () => {
      if (this.slots.get(id) === node) this.slots.delete(id);
      this.observer?.unobserve(node); this.schedule();
    };
  }
  schedule = () => { if (!this.frame) this.frame = requestAnimationFrame(this.measure); };
  private changed = (records: MutationRecord[]) => {
    for (const record of records) {
      const target = record.target;
      // A panel body streaming text or DOM never moves its own slot.
      if (!(target instanceof Element) || target.closest(BODY_SELECTOR)) continue;
      if (record.type === "attributes") {
        if (target.matches(GEOMETRY)) { this.schedule(); return; }
        continue;
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node instanceof Element && (node.matches(GEOMETRY) || node.querySelector(GEOMETRY))) { this.schedule(); return; }
      }
    }
  };
  /**
   * The only wheel listener of the dock. Host -> slot is resolved per event
   * from the live maps, so a moved slot, a remounted host or a hidden region
   * can never leave a stale mapping, and teardown removes the single listener.
   */
  private wheel = (event: WheelEvent) => {
    if (!this.layer || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest<HTMLElement>(BODY_SELECTOR);
    const id = host?.dataset.panel as PanelId | undefined;
    const slot = id === undefined ? undefined : this.slots.get(id);
    if (!target || !host || !slot) return;
    const plan = planScroll(
      event,
      readChain(scrollChain(target, host)),
      readChain(scrollChain(slot.parentElement)),
      { width: window.innerWidth, height: window.innerHeight },
    );
    const destination = plan.target;
    if (!plan.handled || !destination) return;
    // The body is already at its edge for this direction, so preventing the
    // default cannot cancel a native scroll that would still have room.
    event.preventDefault();
    destination.element.scrollTop = plan.top;
    if (plan.left !== destination.scrollLeft) destination.element.scrollLeft = plan.left;
  };
  private measure = () => {
    this.frame = 0;
    if (!this.hosts.size) return;
    // Read every rect and ancestor style first, then write: one layout pass per
    // frame instead of a forced reflow between two panels.
    const readings = [];
    for (const [id, host] of this.hosts) {
      const slot = this.slots.get(id);
      const rect = slot?.getBoundingClientRect();
      let visible = Boolean(slot && rect && rect.width > 0 && rect.height > 0 && slot.getClientRects().length && !slot.closest('[inert], [hidden]'));
      let left = rect?.left ?? 0, right = rect?.right ?? 0, top = rect?.top ?? 0, bottom = rect?.bottom ?? 0;
      if (slot && rect && visible) {
        for (let parent = slot.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          if (css.visibility === "hidden" || css.display === "none") { visible = false; break; }
          const clipsX = /auto|scroll|hidden|clip/.test(css.overflowX);
          const clipsY = /auto|scroll|hidden|clip/.test(css.overflowY);
          if (!clipsX && !clipsY) continue;
          const box = parent.getBoundingClientRect();
          if (clipsX) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
          if (clipsY) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
        }
      }
      const width = rect?.width ?? host.visibility.width;
      const height = rect?.height ?? host.visibility.height;
      const shown = visible && right > left && bottom > top;
      const floating = slot?.closest<HTMLElement>("[data-dock-float]");
      const z = floating ? 32 + Number(floating.dataset.dockOrder ?? 0) * 2 : slot?.closest(".dock-rail-overlay") ? 30 : slot?.closest(".adaptive-workbench[data-layout-overlay]") ? 42 : 12;
      const style = rect && shown
        ? `left:${rect.left}px;top:${rect.top}px;width:${width}px;height:${height}px;z-index:${z};clip-path:inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)`
        : "";
      readings.push({ host, visible, width, height, shown, style });
    }
    for (const { host, visible, width, height, shown, style } of readings) {
      // One signature per host: unchanged geometry never rewrites an attribute,
      // so a frame that only re-reads rects causes no DOM churn.
      const signature = `${shown ? 1 : 0}|${style}`;
      if (signature !== host.signature) {
        host.signature = signature;
        const { element } = host;
        if (element.hidden !== !shown) element.hidden = !shown;
        if (element.inert !== !shown) element.inert = !shown;
        if (style && element.getAttribute("style") !== style) element.setAttribute("style", style);
      }
      // Scrolling a card out of the viewport clips its host but isn't a business hide.
      if (host.visibility.visible !== visible || (visible && (host.visibility.width !== width || host.visibility.height !== height))) {
        host.visibility = { visible, width: visible ? width : host.visibility.width, height: visible ? height : host.visibility.height };
        for (const listener of host.listeners) listener();
      }
    }
  };
}
