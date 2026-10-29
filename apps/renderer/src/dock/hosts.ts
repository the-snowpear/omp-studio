import type { PanelId, PanelVisibility } from "./types";

type Host = { element: HTMLDivElement; visibility: PanelVisibility; listeners: Set<() => void>; subscribe: (listener: () => void) => () => void; snapshot: () => PanelVisibility };
const EMPTY: PanelVisibility = { visible: false, width: 0, height: 0 };

/** One read/write batch owns all panel geometry, including clipping while cards scroll. */
export class PanelHosts {
  private hosts = new Map<PanelId, Host>();
  private slots = new Map<PanelId, HTMLElement>();
  private layer: HTMLElement | null = null;
  private observer: ResizeObserver | undefined;
  private mutations?: MutationObserver;
  private frame = 0;
  get(id: PanelId): Host {
    let host = this.hosts.get(id);
    if (!host) {
      const element = document.createElement("div");
      element.className = "dock-panel-content";
      element.dataset.panel = id;
      element.inert = true;
      element.hidden = true;
      host = { element, visibility: EMPTY, listeners: new Set(), subscribe: listener => { host!.listeners.add(listener); return () => { host!.listeners.delete(listener); }; }, snapshot: () => host!.visibility };
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
    this.mutations = new MutationObserver(this.schedule);
    this.mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "inert", "data-layout-overlay", "style"] });
    document.addEventListener("scroll", this.schedule, true);
    window.addEventListener("resize", this.schedule);
    this.schedule();
    return () => {
      this.observer?.disconnect(); this.mutations?.disconnect();
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
  private measure = () => {
    this.frame = 0;
    const readings = [...this.hosts].map(([id, host]) => {
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
      const floating = slot?.closest<HTMLElement>('[data-dock-float]');
      const overlay = slot?.closest('.dock-rail-overlay');
      const drawer = slot?.closest('[data-dock-float]') ? null : slot?.closest('.adaptive-workbench[data-layout-overlay]');
      return { host, rect, visible, left, right, top, bottom, z: floating ? 32 + Number(floating.dataset.dockOrder ?? 0) * 2 : overlay ? 30 : drawer ? 42 : 12 };
    });
    for (const { host, rect, visible, left, right, top, bottom, z } of readings) {
      const { element } = host;
      const width = rect?.width ?? host.visibility.width;
      const height = rect?.height ?? host.visibility.height;
      const shown = visible && right > left && bottom > top;
      if (element.hidden !== !shown) element.hidden = !shown;
      if (element.inert !== !shown) element.inert = !shown;
      if (rect && shown) {
        const style = `left:${rect.left}px;top:${rect.top}px;width:${width}px;height:${height}px;z-index:${z};clip-path:inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)`;
        if (element.getAttribute("style") !== style) element.setAttribute("style", style);
      }
      // Scrolling a card out of the viewport clips its host but isn't a business hide.
      if (host.visibility.visible !== visible || (visible && (host.visibility.width !== width || host.visibility.height !== height))) {
        host.visibility = { visible, width: visible ? width : host.visibility.width, height: visible ? height : host.visibility.height };
        for (const listener of host.listeners) listener();
      }
    }
  };
}
