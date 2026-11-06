import type { PanelId } from "./types";

/** Named snapshots leave the scrolling list. Clip their animated groups back to
 * its viewport, including the moving card frames and the separate body hosts. */
export function railTransitionClip(panels: readonly PanelId[], document: Document = globalThis.document, surface: Document = document) {
  const root = surface.documentElement;
  const window = surface.defaultView!;
  const style = surface.createElement("style");
  style.dataset.dockTransitionClip = "";
  style.textContent = panels.map(id => `:root[data-dock-rail-transition] .dock-panel-content[data-panel="${id}"][data-dock-region="rail"][data-dock-rail-transition-active] { view-transition-name: dock-rail-body-${id}; }`).join("\n");
  surface.head.append(style);
  const names = panels.flatMap(id => [`dock-rail-${id}`, `dock-rail-heading-${id}`, `dock-rail-body-${id}`]);
  const rules = names.map(name => {
    const sheet = style.sheet!;
    const index = sheet.insertRule(`:root[data-dock-rail-transition]::view-transition-group(${name}) {}`, sheet.cssRules.length);
    return { name, rule: sheet.cssRules[index] as CSSStyleRule };
  });
  let frame = 0;
  let disposed = false;
  const dispose = () => { disposed = true; window.cancelAnimationFrame(frame); style.remove(); };
  const paint = () => {
    if (disposed) return;
    const rail = document.querySelector<HTMLElement>(".dock-rail-expanded");
    const list = rail?.querySelector<HTMLElement>(".dock-card-list");
    if (!rail || !list) return;
    const viewport = rail.getBoundingClientRect();
    const area = list.getBoundingClientRect();
    const clips = rules.map(({ name, rule }) => {
      const css = window.getComputedStyle(root, `::view-transition-group(${name})`);
      const width = Number.parseFloat(css.width), height = Number.parseFloat(css.height);
      if (!width || !height) return null;
      const matrix = new DOMMatrixReadOnly(css.transform === "none" ? undefined : css.transform);
      const x = matrix.m41, y = matrix.m42;
      return { rule, value: `inset(${Math.max(0, area.top - y)}px ${Math.max(0, x + width - area.right)}px ${Math.max(0, y + height - viewport.bottom)}px ${Math.max(0, area.left - x)}px)` };
    });
    for (const clip of clips) if (clip) clip.rule.style.clipPath = clip.value;
    frame = window.requestAnimationFrame(paint);
  };
  return { dispose, watch(transition: ViewTransition) { void transition.ready?.then(paint).catch(() => {}); } };
}
