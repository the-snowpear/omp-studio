import { planScroll, readChain, scrollChain } from "./scrollChain";
import type { PanelId, PanelVisibility } from "./types";
import { panelBaseId } from "./types";

type Host = { element: HTMLDivElement; surface: Document; surfaceSnapshot: () => Document; visibility: PanelVisibility; toolbar: HTMLElement | null; listeners: Set<() => void>; subscribe: (listener: () => void) => () => void; snapshot: () => PanelVisibility; toolbarSnapshot: () => HTMLElement | null; signature: string; pendingScroll?: { element: Element; top: number; left: number }[] };
type MoveTarget = HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
const EMPTY: PanelVisibility = { visible: false, width: 0, height: 0 };
const BODY = "dock-panel-content";
const BODY_SELECTOR = ".dock-panel-content";
/** Dock geometry only: streaming inside a panel body cannot move its slot. */
const GEOMETRY = [
  "[data-dock-slot]", "[data-dock-cards]", "[data-dock-groups]", "[data-dock-region]", "[data-dock-group]", "[data-dock-float]", "[data-dock-entry]",
  ".dock-drag-preview", ".dock-card-region", ".dock-card-list", ".dock-card", ".dock-card-body", ".dock-groups", ".dock-group-region", ".dock-group", ".dock-group-body",
  ".dock-left-cards", ".dock-rail-expanded", ".dock-rail-compact", ".dock-rail-overlay", ".dock-float", ".adaptive-workbench",
].join(", ");

/** Intersect a rail frame's bottom corners with the scrolling viewport. */
function railClip(width: number, height: number, left: number, top: number, right: number, bottom: number, radius: number, overlap: number) {
  const start = height - overlap;
  const first = Math.max(top, start);
  const angle = (y: number) => Math.asin(Math.max(0, Math.min(1, (y - start) / radius)));
  const begin = angle(first), end = angle(bottom);
  const points = Array.from({ length: 13 }, (_, i) => {
    const theta = begin + (end - begin) * i / 12;
    const y = start + radius * Math.sin(theta);
    const edge = radius * (1 - Math.cos(theta));
    return { y, left: Math.max(left, edge), right: Math.min(right, width - edge) };
  });
  const pixel = (n: number) => `${Math.round(n * 100) / 100}px`;
  const pair = (x: number, y: number) => `${pixel(x)} ${pixel(y)}`;
  const leftTop = points[0]!.left, rightTop = points[0]!.right;
  return `polygon(${[
    pair(leftTop, top), pair(rightTop, top),
    ...points.map(p => pair(p.right, p.y)),
    ...points.reverse().map(p => pair(p.left, p.y)),
  ].join(", ")})`;
}

/** One read/write batch owns the geometry of panel hosts outside their slots. */
export class PanelHosts {
  private hosts = new Map<PanelId, Host>();
  private slots = new Map<PanelId, HTMLElement>();
  private previewSlots = new Map<PanelId, HTMLElement>();
  private autoHeightOwners = new Map<PanelId, Set<symbol>>();
  private previewAutoHeight = new Map<PanelId, boolean>();
  private previewToolbars = new Map<PanelId, { node: HTMLElement | null }>();
  private detachListeners = new Set<() => void>();
  private layer: HTMLElement | null = null;
  private localLayer: HTMLElement | null = null;
  attachLocalLayer(layer: HTMLElement): () => void {
    this.localLayer = layer;
    for (const id of this.hosts.keys()) this.placeHost(id);
    this.schedule();
    return () => { this.localLayer = null; };
  }
  private observer: ResizeObserver | undefined;
  private mutations: MutationObserver | undefined;
  private frame = 0;
  private windows = new Map<Document, { layer: HTMLElement; dispose: () => void }>();
  get(id: PanelId): Host {
    let host = this.hosts.get(id);
    if (!host) {
      const element = document.createElement("div");
      element.className = BODY;
      element.dataset.panel = id;
      element.dataset.dockBase = panelBaseId(id);
      if (id === "context-viewer" || id === "annotations") element.id = `dock-${id}-content`;
      element.inert = true;
      element.hidden = true;
      host = { element, surface: document, surfaceSnapshot: () => host!.surface, visibility: EMPTY, toolbar: null, listeners: new Set(), subscribe: listener => { host!.listeners.add(listener); return () => { host!.listeners.delete(listener); }; }, snapshot: () => host!.visibility, toolbarSnapshot: () => this.previewToolbars.has(id) ? this.previewToolbars.get(id)!.node : host!.toolbar, signature: "0|" };
      this.hosts.set(id, host);
      this.layer?.append(element);
    }
    return host;
  }
  /** Dynamic Agent views release their portal host when closed or leaving scope. */
  release(id: PanelId, element: HTMLElement): void {
    const host = this.hosts.get(id);
    if (!host || host.element !== element) return;
    const slot = this.slots.get(id);
    if (slot) this.observer?.unobserve(slot);
    this.slots.delete(id);
    this.previewSlots.delete(id);
    this.autoHeightOwners.delete(id);
    this.previewAutoHeight.delete(id);
    this.previewToolbars.delete(id);
    host.element.remove();
    this.hosts.delete(id);
  }
  attach(layer: HTMLElement) {
    this.layer = layer;
    for (const id of this.hosts.keys()) this.placeHost(id);
    this.observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(this.schedule);
    this.observer?.observe(document.documentElement);
    for (const slot of this.slots.values()) this.observer?.observe(slot);
    this.mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(this.changed);
    this.mutations?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "inert", "data-layout-overlay", "data-dock-modal", "style"] });
    layer.addEventListener("wheel", this.wheel, { passive: false });
    document.addEventListener("scroll", this.scrolled, true);
    window.addEventListener("resize", this.schedule);
    this.schedule();
    return () => {
      for (const listener of this.detachListeners) listener();
      const previews = [...this.previewSlots.keys()];
      this.previewSlots.clear(); this.previewAutoHeight.clear(); this.previewToolbars.clear();
      for (const id of previews) this.syncAutoHeight(id);
      layer.removeEventListener("wheel", this.wheel);
      this.observer?.disconnect(); this.mutations?.disconnect();
      this.observer = this.mutations = undefined;
      document.removeEventListener("scroll", this.scrolled, true);
      window.removeEventListener("resize", this.schedule);
      cancelAnimationFrame(this.frame); this.frame = 0; this.layer = null;
    };
  }
  slot(id: PanelId, node: HTMLElement) {
    this.get(id);
    this.slots.set(id, node); this.placeHost(id); this.observer?.observe(node); this.schedule();
    return () => {
      if (this.slots.get(id) === node) { this.slots.delete(id); this.placeHost(id); }
      this.observer?.unobserve(node); this.schedule();
    };
  }
  rememberScroll(id: PanelId): void {
    const host = this.hosts.get(id);
    if (!host || host.element.hidden || host.pendingScroll) return;
    const positions = [host.element, ...host.element.querySelectorAll("*")].map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    host.pendingScroll = positions.filter(position => position.top !== 0 || position.left !== 0);
    this.schedule();
  }
  private placeHost(id: PanelId): void {
    const host = this.hosts.get(id);
    if (!host) return;
    const preview = this.previewSlots.has(id);
    const slot = this.previewSlots.get(id) ?? this.slots.get(id);
    const doc = slot?.ownerDocument ?? document;
    // Keep the stable host layer in browsers that cannot move an iframe or
    // active editor without reloading it.
    const embedded = Boolean(!preview && slot?.closest(".dock-card-region-rail") && (slot as MoveTarget).moveBefore);
    const local = slot?.closest("[data-conversation-document]") && this.localLayer?.ownerDocument === doc ? this.localLayer : null;
    const parent = embedded ? slot : local ?? (doc === document ? this.layer : this.windows.get(doc)?.layer);
    if (!parent) return;
    const changed = host.element.parentElement !== parent || host.element.hasAttribute("data-dock-embedded") !== embedded;
    if (host.element.parentElement !== parent) {
      if (embedded || host.element.hasAttribute("data-dock-embedded")) this.rememberScroll(id);
      // moveBefore preserves focus, iframe state and running media when a live
      // panel moves between the rail and the host layer in the same document.
      const movable = parent as MoveTarget;
      if (parent.isConnected && host.element.isConnected && host.element.ownerDocument === doc && movable.moveBefore) movable.moveBefore(host.element, null);
      else parent.append(host.element);
    }
    if (changed) {
      host.element.toggleAttribute("data-dock-embedded", embedded);
      if (embedded) host.element.removeAttribute("style");
      host.signature = "";
    }
    if (host.surface !== doc) {
      host.surface = doc;
      for (const listener of host.listeners) listener();
    }
  }
  /** Hosts stay the same DOM/React nodes when their owning document changes. */
  attachWindow(doc: Document): () => void {
    const view = doc.defaultView!;
    const layer = doc.createElement("div"); layer.className = "dock-host-layer"; if (this.layer?.dataset.conversationOwner) layer.dataset.conversationOwner = this.layer.dataset.conversationOwner; doc.body.append(layer);
    const resize = new ResizeObserver(this.schedule); resize.observe(doc.documentElement);
    const mutations = new MutationObserver(this.changed);
    mutations.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "inert", "style"] });
    layer.addEventListener("wheel", this.wheel, { passive: false });
    doc.addEventListener("scroll", this.scrolled, true); doc.addEventListener("visibilitychange", this.schedule); view.addEventListener("resize", this.schedule);
    const dispose = () => {
      for (const [id, slot] of this.slots) if (slot.ownerDocument === doc) this.slots.delete(id);
      for (const [id, host] of this.hosts) if (host.surface === doc) this.placeHost(id);
      resize.disconnect(); mutations.disconnect(); layer.removeEventListener("wheel", this.wheel);
      doc.removeEventListener("scroll", this.scrolled, true); doc.removeEventListener("visibilitychange", this.schedule); view.removeEventListener("resize", this.schedule);
      layer.remove(); this.windows.delete(doc); this.schedule();
    };
    this.windows.set(doc, { layer, dispose });
    return dispose;
  }
  toolbar(id: PanelId, node: HTMLElement) {
    const host = this.get(id);
    host.toolbar = node;
    for (const listener of host.listeners) listener();
    return () => {
      if (host.toolbar !== node) return;
      host.toolbar = null;
      for (const listener of host.listeners) listener();
    };
  }
  private syncAutoHeight(id: PanelId) {
    const element = this.hosts.get(id)?.element;
    if (!element) return;
    const automatic = this.previewAutoHeight.get(id) ?? !!this.autoHeightOwners.get(id)?.size;
    if (automatic) element.dataset.dockAutoHeight = "true"; else delete element.dataset.dockAutoHeight;
  }
  autoHeight(id: PanelId) {
    this.get(id);
    const owners = this.autoHeightOwners.get(id) ?? new Set<symbol>();
    const owner = Symbol();
    owners.add(owner); this.autoHeightOwners.set(id, owners); this.syncAutoHeight(id);
    return () => {
      owners.delete(owner);
      if (!owners.size && this.autoHeightOwners.get(id) === owners) this.autoHeightOwners.delete(id);
      this.syncAutoHeight(id);
    };
  }
  previewSlot(id: PanelId, node: HTMLElement, autoHeight = false) {
    this.previewSlots.set(id, node); this.previewAutoHeight.set(id, autoHeight); this.syncAutoHeight(id);
    this.placeHost(id); this.observer?.observe(node); this.schedule();
    return () => {
      if (this.previewSlots.get(id) === node) {
        this.previewSlots.delete(id); this.previewAutoHeight.delete(id); this.syncAutoHeight(id); this.placeHost(id);
      }
      this.observer?.unobserve(node); this.schedule();
    };
  }
  previewToolbar(id: PanelId, node: HTMLElement | null) {
    const host = this.get(id);
    const lease = { node };
    this.previewToolbars.set(id, lease);
    for (const listener of host.listeners) listener();
    return () => {
      if (this.previewToolbars.get(id) !== lease) return;
      this.previewToolbars.delete(id);
      for (const listener of host.listeners) listener();
    };
  }
  onDetach(listener: () => void) {
    this.detachListeners.add(listener);
    return () => { this.detachListeners.delete(listener); };
  }
  /** Chromium can drop alternate wheel steps at a nested scrollport's edge. */
  attachRailScroll(list: HTMLElement): () => void {
    let remainder = 0;
    let previousHost: Element | null = null;
    const wheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const host = target?.closest<HTMLElement>('.dock-panel-content[data-dock-embedded]');
      if (!target || !host || !event.cancelable || event.shiftKey) { remainder = 0; previousHost = null; return; }
      if (host !== previousHost) { remainder = 0; previousHost = host; }
      const inside = scrollChain(target, host).filter(element => /auto|scroll|overlay/.test(getComputedStyle(element).overflowY));
      // An intentionally contained scrollport (such as an open menu) keeps its wheel.
      if (!inside.some(element => element !== host) || inside.some(element => /^(contain|none)$/.test(getComputedStyle(element).overscrollBehaviorY))) { remainder = 0; return; }
      const view = target.ownerDocument.defaultView!;
      const plan = planScroll(event, readChain(inside), readChain([list]), { width: view.innerWidth, height: view.innerHeight });
      if (!plan.handled) { remainder = 0; return; }
      event.preventDefault();
      const desired = plan.top + remainder;
      list.scrollTop = desired;
      // Scroll offsets can be rounded to pixels; retain trackpad fractions.
      remainder = desired - list.scrollTop;
    };
    list.addEventListener("wheel", wheel, { passive: false });
    return () => list.removeEventListener("wheel", wheel);
  }
  schedule = () => { if (!this.frame) this.frame = requestAnimationFrame(this.measure); };
  private scrolled = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && (target.closest(BODY_SELECTOR) || (target.matches('.dock-card-list[data-dock-cards="rail"]') && (target as MoveTarget).moveBefore && !this.previewSlots.size))) return;
    this.schedule();
  };
  /** Measure inside the caller's frame instead of the next one. A slot can move
   *  without resizing (an animated rail width pushing the sidebar right does
   *  exactly that), and then a one-frame delay shows up as the panel body
   *  trailing its slot by a dozen pixels. */
  flush = () => {
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
    this.measure();
  };
  private changed = (records: MutationRecord[]) => {
    for (const record of records) {
      const target = record.target;
      if (target.nodeType !== 1 || (target as Element).closest(BODY_SELECTOR)) continue;
      if (record.type === "attributes") {
        if ((target as Element).matches(GEOMETRY)) { this.schedule(); return; }
        continue;
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType === 1 && ((node as Element).matches(GEOMETRY) || (node as Element).querySelector(GEOMETRY))) { this.schedule(); return; }
      }
    }
  };
  private wheel = (event: WheelEvent) => {
    if (!this.layer || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    const target = (event.target as Node | null)?.nodeType === 1 ? event.target as Element : null;
    const host = target?.closest<HTMLElement>(BODY_SELECTOR);
    const id = host?.dataset.panel as PanelId | undefined;
    const slot = id === undefined ? undefined : this.previewSlots.get(id) ?? this.slots.get(id);
    if (!target || !host || !slot) return;
    const view = target.ownerDocument.defaultView!;
    const plan = planScroll(event, readChain(scrollChain(target, host)), readChain(scrollChain(slot.parentElement)), { width: view.innerWidth, height: view.innerHeight });
    const destination = plan.target;
    if (!plan.handled || !destination) return;
    event.preventDefault();
    destination.element.scrollTop = plan.top;
    if (plan.left !== destination.scrollLeft) destination.element.scrollLeft = plan.left;
  };
  private measure = () => {
    this.frame = 0;
    if (!this.hosts.size) return;
    // Read every rect and ancestor style first, then write once per host.
    const readings = [];
    const pixel = (value: number) => Math.round(value * 100) / 100;
    for (const [id, host] of this.hosts) {
      const slot = this.previewSlots.get(id) ?? this.slots.get(id);
      const preview = this.previewSlots.has(id) || !!slot?.closest(".dock-layout-preview");
      const doc = slot?.ownerDocument ?? host.surface;
      const rect = slot?.getBoundingClientRect();
      let visible = Boolean(slot && rect && rect.width > 0 && rect.height > 0 && slot.getClientRects().length && !slot.closest('[inert], [hidden]') && (doc === document || !doc.hidden));
      let left = rect?.left ?? 0, right = rect?.right ?? 0, top = rect?.top ?? 0, bottom = rect?.bottom ?? 0;
      if (slot && rect && visible) {
        for (let parent = slot.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
          const css = doc.defaultView!.getComputedStyle(parent);
          if (css.visibility === "hidden" || css.display === "none") { visible = false; break; }
          const clipsX = /auto|scroll|hidden|clip/.test(css.overflowX);
          const clipsY = /auto|scroll|hidden|clip/.test(css.overflowY);
          if (!clipsX && !clipsY) continue;
          const box = parent.getBoundingClientRect();
          if (clipsX) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
          if (clipsY) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
        }
      }
      // A full-screen group is portalled to the body (DockLauncher.tsx): above the workbench, below menus.
      const fullscreen = !!slot?.closest("[data-dock-fullscreen]");
      const width = rect?.width ?? host.visibility.width;
      const height = rect?.height ?? host.visibility.height;
      // Embedded rail hosts are clipped by the card list itself. Keep the
      // offscreen host mounted so it can scroll back into view natively.
      const embedded = host.element.hasAttribute("data-dock-embedded");
      const shown = visible && (embedded || (right > left && bottom > top));
      const floating = slot?.closest<HTMLElement>("[data-dock-float]");
      const overlay = slot?.closest(".dock-rail-overlay, .dock-rail-expanded");
      // The host is portalled outside the rail's rounded frame. Account for the
      // expanded card's resize strip when matching the inner bottom corners.
      const railFrame = slot?.closest<HTMLElement>(".dock-rail-overlay, .dock-card-region-rail .dock-card");
      let railRadius = 0, railOverlap = 0;
      if (railFrame && rect) {
        const css = doc.defaultView!.getComputedStyle(railFrame);
        const border = Number.parseFloat(css.borderBottomWidth) || 0;
        railRadius = pixel(Math.max(0, (Number.parseFloat(css.borderBottomLeftRadius) || 0) - border));
        const inset = railFrame.getBoundingClientRect().bottom - border - rect.bottom;
        railOverlap = pixel(Math.max(0, railRadius - Math.max(0, inset)));
      }
      const drawer = slot?.closest(".adaptive-workbench[data-layout-overlay]");
      const regionNode = slot?.closest<HTMLElement>("[data-dock-cards], [data-dock-region]");
      const region = floating ? "float" : regionNode?.dataset.dockCards ?? regionNode?.dataset.dockRegion ?? "";
      const maximized = floating?.classList.contains("is-maximized") ?? false;
      const z = preview ? 58 : fullscreen ? 53 : floating?.hasAttribute("data-dock-modal") ? 82 : floating ?32 + Number(floating.dataset.dockOrder ?? 0) * 2 : overlay ? 30 : drawer ? 42 : 12;
      const clippedLeft = rect ? Math.max(0, left - rect.left) : 0;
      const clippedTop = rect ? Math.max(0, top - rect.top) : 0;
      const clippedRight = rect ? Math.min(width, right - rect.left) : width;
      const clippedBottom = rect ? Math.min(height, bottom - rect.top) : height;
      const clip = railOverlap && clippedBottom > height - railOverlap
        ? railClip(width, height, clippedLeft, clippedTop, clippedRight, clippedBottom, railRadius, railOverlap)
        : `inset(${clippedTop}px ${width - clippedRight}px ${height - clippedBottom}px ${clippedLeft}px)`;
      const style = rect && shown && !embedded
        ? `left:${rect.left}px;top:${rect.top}px;width:${width}px;height:${height}px;z-index:${z};clip-path:${clip}`
        : "";
      const workbenchSurface = !preview && (!floating || floating.hasAttribute("data-workbench-surface"));
      readings.push({ host, visible, width, height, shown, style, preview, region, maximized, workbenchSurface, windowId: floating?.dataset.dockWindow });
    }
    for (const { host, visible, width, height, shown, style, preview, region, maximized, workbenchSurface, windowId } of readings) {
      const { element } = host;
      element.toggleAttribute("data-workbench-surface", workbenchSurface);
      if (windowId) element.dataset.dockWindow = windowId; else delete element.dataset.dockWindow;
      if (element.dataset.dockRegion !== region) element.dataset.dockRegion = region;
      if (element.hasAttribute("data-dock-maximized") !== maximized) element.toggleAttribute("data-dock-maximized", maximized);
      if (element.classList.contains("is-drag-preview") !== preview) element.classList.toggle("is-drag-preview", preview);
      const signature = `${shown ? 1 : 0}|${style}`;
      if (signature !== host.signature) {
        host.signature = signature;
        if (element.hidden !== !shown) element.hidden = !shown;
        if (element.inert !== !shown) element.inert = !shown;
        if (style && element.getAttribute("style") !== style) element.setAttribute("style", style);
      }
      // Moving a hidden scroll container resets its offsets even with moveBefore.
      // Restore them once its destination has its real size and is visible.
      if (shown && host.pendingScroll) {
        for (const position of host.pendingScroll) if (element.contains(position.element)) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
        delete host.pendingScroll;
      }
      // Clipping a card during scroll is not a business hide.
      if (host.visibility.visible !== visible || (visible && (host.visibility.width !== width || host.visibility.height !== height))) {
        host.visibility = { visible, width: visible ? width : host.visibility.width, height: visible ? height : host.visibility.height };
        for (const listener of host.listeners) listener();
      }
    }
  };
}
