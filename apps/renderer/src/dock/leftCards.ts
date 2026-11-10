import type { PanelId } from "./types";

export type LeftCardShares = Partial<Record<PanelId, number | null>>;
const SHARE = "--dock-left-share";

/** A separator borrows space from the next expanded pane, leaving all others alone. */
export function leftCardResize(card: HTMLElement) {
  const cards = [...card.parentElement!.querySelectorAll<HTMLElement>(":scope > .dock-card:not(.is-collapsed)")];
  const index = cards.indexOf(card);
  if (index < 0 || index === cards.length - 1) return null;
  const heights = cards.map(node => node.querySelector<HTMLElement>(".dock-card-body")!.getBoundingClientRect().height);
  const previous = cards.map(node => node.style.getPropertyValue(SHARE));
  const current = heights[index]!, next = heights[index + 1]!;
  const average = heights.reduce((sum, height) => sum + height, 0) / heights.length;
  if (!average) return null;
  return {
    update(delta: number): LeftCardShares {
      // Keep a small body visible, but do not jump panes that were already smaller.
      const change = Math.max(Math.min(40, current) - current, Math.min(next - Math.min(40, next), delta));
      const shares: LeftCardShares = {};
      cards.forEach((node, at) => {
        const height = heights[at]! + (at === index ? change : at === index + 1 ? -change : 0);
        const share = Math.max(0.001, height / average);
        shares[node.dataset.dockCard as PanelId] = share;
        node.style.setProperty(SHARE, String(share));
      });
      return shares;
    },
    cancel() {
      cards.forEach((node, at) => {
        if (previous[at]) node.style.setProperty(SHARE, previous[at]!);
        else node.style.removeProperty(SHARE);
      });
    },
  };
}
