import { useCallback, useState } from "react";
import type { DeckGroup } from "./deckModel";

export type DeckView = "formation" | "timeline" | "orbit" | "comms";
export type DeckStageView = Exclude<DeckView, "formation">;
export type ReplaySpeed = 1 | 4 | 16;

/**
 * What the user set up in one deck: the view, the selection, the filter, the
 * replay instant and the camera of each view. Kept per panel instance and scope
 * for this renderer run, so moving the panel between regions, switching
 * language or flipping back from another session restores it as it was.
 */
export type DeckUi = {
  view: DeckView;
  stage: DeckStageView;
  selected: string | null;
  /** Narrow tiers show the inspector as a sheet over the view. */
  sheet: boolean;
  lens: boolean;
  query: string;
  groups: DeckGroup[];
  grouping: "tree" | "status";
  collapsed: string[];
  /** Replay instant; null follows the present. */
  replay: number | null;
  speed: ReplaySpeed;
  byEvent: boolean;
  timeline: { follow: boolean; span: number | null; end: number | null };
  orbit: { zoom: number; x: number; y: number };
};

const initial = (): DeckUi => ({
  view: "formation", stage: "orbit", selected: null, sheet: false, lens: false, query: "", groups: [], grouping: "tree", collapsed: [],
  replay: null, speed: 4, byEvent: false, timeline: { follow: true, span: null, end: null }, orbit: { zoom: 1, x: 0, y: 0 },
});

const book = new Map<string, DeckUi>();

export type DeckUpdate = (patch: Partial<DeckUi> | ((ui: DeckUi) => Partial<DeckUi>)) => void;

export function useDeckUi(key: string): [DeckUi, DeckUpdate] {
  const [, refresh] = useState(0);
  let ui = book.get(key);
  if (!ui) { ui = initial(); book.set(key, ui); }
  const update: DeckUpdate = useCallback(patch => {
    const current = book.get(key) ?? initial();
    const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
    book.set(key, next);
    refresh(value => value + 1);
  }, [key]);
  return [ui, update];
}

export function __resetDeckUiForTests() {
  book.clear();
}
