import type { PanelHosts } from "./hosts";
import { isInstancePanelId, panelBaseId, type DockLayout, type DockRect, type PanelDefinition, type PanelId } from "./types";

export type CardPlacement = {
  region: "left" | "rail";
  icons: boolean;
  rects?: Partial<Record<PanelId, DockRect>>;
  sizes: Partial<Record<PanelId, { body: number; height: number }>>;
};

/** Reordering translates cards visually; hit tests and landing slots use their
 * final layout positions so the animation cannot move its own destination. */
export function cardLayoutRect(card: HTMLElement): DOMRect {
  const rect = card.getBoundingClientRect();
  const transform = getComputedStyle(card).transform;
  if (!transform || transform === "none") return rect;
  const matrix = new DOMMatrixReadOnly(transform);
  return new DOMRect(rect.x - matrix.m41, rect.y - matrix.m42, rect.width, rect.height);
}

export function cardList(region: "left" | "rail", document: Document = globalThis.document): HTMLElement | null {
  const selector = `.dock-card-list[data-dock-cards="${region}"]${region === "rail" ? ", .dock-rail-icon-list" : ""}`;
  return [...document.querySelectorAll<HTMLElement>(selector)].find(list => !list.closest("[hidden], [inert]") && list.getClientRects().length > 0 && list.getBoundingClientRect().width > 0) ?? null;
}

// Keep fractional CSS geometry while excluding the scrollbar and list borders.
const listWidth = (list: HTMLElement, rect = list.getBoundingClientRect()) => rect.width - (list.offsetWidth - list.clientWidth);

export const usesNaturalHeight = (id: PanelId) => {
  const base = panelBaseId(id);
  return base !== "terminal" && base !== "browser" && base !== "computer" && base !== "agent-detail" && !isInstancePanelId(id);
};

export function contextCardGeometry(host: HTMLElement) {
  const card = host.querySelector<HTMLElement>(".context-card");
  const rows = card?.querySelector<HTMLElement>(".context-card-rows");
  if (!card || !rows) return null;
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const css = getComputedStyle(card);
  let fixed = pixels(css.paddingTop) + pixels(css.paddingBottom);
  for (const child of [...card.children].filter(child => child !== rows)) {
    const style = getComputedStyle(child);
    fixed += child.getBoundingClientRect().height + pixels(style.marginTop) + pixels(style.marginBottom);
  }
  const content = [...rows.children].reduce((height, row) => {
    const style = getComputedStyle(row);
    return height + row.getBoundingClientRect().height + pixels(style.marginTop) + pixels(style.marginBottom);
  }, 0);
  return { minimum: Math.ceil(fixed), natural: Math.ceil(fixed + content) };
}

/** Measure the live contents using the destination's automatic-height styles. */
function naturalBody(host: HTMLElement, width: number, region: "left" | "rail", context: boolean) {
  const previousWidth = host.style.width;
  const previousRegion = host.getAttribute("data-dock-region");
  const previousAuto = host.getAttribute("data-dock-auto-height");
  host.dataset.dockRegion = region;
  host.dataset.dockAutoHeight = "true";
  const children = [...host.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hidden);
  host.style.width = `${width}px`;
  const top = host.getBoundingClientRect().top;
  const geometry = context ? contextCardGeometry(host) : null;
  const height = geometry?.natural ?? children.reduce((max, child) => Math.max(max, child.getBoundingClientRect().bottom - top, child.offsetTop + child.scrollHeight), 0);
  if (previousWidth) host.style.width = previousWidth; else host.style.removeProperty("width");
  if (previousRegion === null) delete host.dataset.dockRegion; else host.setAttribute("data-dock-region", previousRegion);
  if (previousAuto === null) delete host.dataset.dockAutoHeight; else host.setAttribute("data-dock-auto-height", previousAuto);
  return { height: Math.ceil(height), minimum: geometry?.minimum };
}

export function measureCardPlacement(region: "left" | "rail", layout: DockLayout, panels: PanelId[], hosts: PanelHosts, definitions: readonly PanelDefinition[], document: Document = globalThis.document): CardPlacement {
  const list = cardList(region, document);
  const icons = list?.classList.contains("dock-rail-icon-list") ?? false;
  const width = list ? listWidth(list) : layout[region].width;
  const css = list ? getComputedStyle(list) : null;
  const contentWidth = width - (Number.parseFloat(css?.paddingLeft ?? "0") || 0) - (Number.parseFloat(css?.paddingRight ?? "0") || 0) - (region === "rail" ? 2 : 0);
  const sizes: CardPlacement["sizes"] = {};
  for (const id of panels) {
    const definition = definitions.find(item => item.id === id) ?? { id, title: id, icon: "box" as const };
    const preference = layout.cards[id]!;
    const base = panelBaseId(id);
    const minimum = Math.max(definition.minHeight ?? 64, base === "terminal" ? 240 : 0);
    const initial = Math.max(minimum, definition.initialHeight ?? 280);
    const natural = usesNaturalHeight(id);
    // A newly targeted panel may not have mounted yet; use its normal initial
    // height until the live content can be measured instead of clipping it to
    // the minimum during the first drag preview.
    const measured = !icons && !preference.collapsed && natural && (preference.height === null || id === "context")
      ? naturalBody(hosts.get(id).element, contentWidth, region, id === "context") : undefined;
    const naturalHeight = measured?.height || initial;
    const body = icons || preference.collapsed ? 0 : id === "context" && measured?.minimum !== undefined
      ? Math.max(Math.max(minimum, measured.minimum), Math.min(preference.height ?? naturalHeight, naturalHeight))
      : preference.height ?? Math.max(minimum, Math.min(initial, naturalHeight));
    sizes[id] = { body, height: icons ? 36 : (region === "rail" ? 46 : 38) + body + (!preference.collapsed && base !== "environment" ? 6 : 0) };
  }
  return { region, icons, sizes };
}

export function cardPlacementRect(placement: CardPlacement, layout: DockLayout, panels: PanelId[], fallback: DockRect, document: Document = globalThis.document): DockRect {
  const list = cardList(placement.region, document);
  if (!list) {
    if (placement.region === "left") return { x: fallback.x, y: fallback.y, width: fallback.width, height: fallback.height };
    const conversation = document.querySelector(".convo-wrap")?.getBoundingClientRect();
    return { x: (conversation?.right ?? fallback.x + fallback.width) - layout.rail.width - 12, y: (conversation?.top ?? fallback.y) + 40, width: layout.rail.width, height: panels.reduce((sum, id) => sum + placement.sizes[id]!.height, 0) };
  }
  const box = list.getBoundingClientRect();
  const css = getComputedStyle(list);
  const gap = Number.parseFloat(css.rowGap) || 0;
  const cards = [...list.querySelectorAll<HTMLElement>(":scope > [data-dock-card]")];
  const height = (id: PanelId) => panels.includes(id) ? placement.sizes[id]!.height : cards.find(card => card.dataset.dockCard === id)!.getBoundingClientRect().height;
  const index = layout[placement.region].panels.indexOf(panels[0]!);
  const left = Number.parseFloat(css.paddingLeft) || 0;
  return {
    x: box.left + left,
    y: box.top + (Number.parseFloat(css.paddingTop) || 0) - list.scrollTop + layout[placement.region].panels.slice(0, index).reduce((sum, id) => sum + height(id) + gap, 0),
    width: placement.icons ? 36 : listWidth(list, box) - left - (Number.parseFloat(css.paddingRight) || 0),
    height: panels.reduce((sum, id) => sum + height(id), 0) + gap * (panels.length - 1),
  };
}
