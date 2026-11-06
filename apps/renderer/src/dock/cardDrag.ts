import type { PanelHosts } from "./hosts";
import { isInstancePanelId, type DockLayout, type DockRect, type PanelDefinition, type PanelId } from "./types";

export type CardPlacement = {
  region: "left" | "rail";
  icons: boolean;
  sizes: Partial<Record<PanelId, { body: number; height: number }>>;
};

export function cardList(region: "left" | "rail", document: Document = globalThis.document): HTMLElement | null {
  const selector = `.dock-card-list[data-dock-cards="${region}"]${region === "rail" ? ", .dock-rail-icon-list" : ""}`;
  return [...document.querySelectorAll<HTMLElement>(selector)].find(list => !list.closest("[hidden], [inert]") && list.getClientRects().length > 0 && list.getBoundingClientRect().width > 0) ?? null;
}

/** Measure the live contents at their destination width, retaining the same DOM. */
function naturalBody(host: HTMLElement, width: number) {
  const previousWidth = host.style.width;
  const children = [...host.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hidden);
  const styles = children.map(child => child.getAttribute("style"));
  host.style.width = `${width}px`;
  for (const child of children) { child.style.height = "auto"; child.style.flex = "none"; child.style.minHeight = "0"; }
  const top = host.getBoundingClientRect().top;
  const height = children.reduce((max, child) => Math.max(max, child.getBoundingClientRect().bottom - top, child.offsetTop + child.scrollHeight), 0);
  children.forEach((child, index) => { if (styles[index] === null) child.removeAttribute("style"); else child.setAttribute("style", styles[index]!); });
  if (previousWidth) host.style.width = previousWidth; else host.style.removeProperty("width");
  return Math.ceil(height);
}

export function measureCardPlacement(region: "left" | "rail", layout: DockLayout, panels: PanelId[], hosts: PanelHosts, definitions: readonly PanelDefinition[], document: Document = globalThis.document): CardPlacement {
  const list = cardList(region, document);
  const icons = list?.classList.contains("dock-rail-icon-list") ?? false;
  const width = list?.getBoundingClientRect().width || layout[region].width;
  const css = list ? getComputedStyle(list) : null;
  const contentWidth = width - (Number.parseFloat(css?.paddingLeft ?? "0") || 0) - (Number.parseFloat(css?.paddingRight ?? "0") || 0) - (region === "rail" ? 2 : 0);
  const sizes: CardPlacement["sizes"] = {};
  for (const id of panels) {
    const definition = definitions.find(item => item.id === id) ?? { id, title: id, icon: "box" as const };
    const preference = layout.cards[id]!;
    const minimum = Math.max(definition.minHeight ?? 64, id === "terminal" ? 240 : 0);
    const initial = Math.max(minimum, definition.initialHeight ?? 280);
    const natural = id !== "terminal" && id !== "browser" && id !== "computer" && id !== "agent-detail" && !isInstancePanelId(id);
    // A newly targeted panel may not have mounted yet; use its normal initial
    // height until the live content can be measured instead of clipping it to
    // the minimum during the first drag preview.
    const measured = !icons && !preference.collapsed && preference.height === null && natural ? naturalBody(hosts.get(id).element, contentWidth) || initial : initial;
    const body = icons || preference.collapsed ? 0 : preference.height ?? Math.max(minimum, id === "context" ? measured : Math.min(initial, measured));
    sizes[id] = { body, height: icons ? 36 : (region === "rail" ? 46 : 38) + body + (!preference.collapsed && id !== "environment" ? 6 : 0) };
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
    width: placement.icons ? 36 : box.width - left - (Number.parseFloat(css.paddingRight) || 0),
    height: panels.reduce((sum, id) => sum + height(id), 0) + gap * (panels.length - 1),
  };
}
