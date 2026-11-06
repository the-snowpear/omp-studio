import type { RefObject } from "react";
import { QueuedDeck } from "../deck/QueuedDeck";
import { PREVIEW_DECK_ITEMS } from "./deckFixtures";
import { usePreviewMode } from "./PreviewContext";

/**
 * Preview-only Deck above the composer. One window, ver1-style 1/N queue.
 * Demo buttons dismiss local cards; they do not call Host, write the reducer,
 * or forge SurfaceCapabilities. Live Ask uses the same QueuedDeck shell.
 */
export function PreviewDeck({
  onCurrentKind,
  planExpanded,
  onPlanExpandedChange,
  planOriginRef,
}: {
  onCurrentKind?: (kind: "plan" | "ask" | null) => void;
  planExpanded?: boolean;
  onPlanExpandedChange?: (open: boolean) => void;
  planOriginRef?: RefObject<HTMLElement | null>;
} = {}) {
  const { marks } = usePreviewMode();
  return (
    <QueuedDeck
      items={PREVIEW_DECK_ITEMS}
      demo
      previewMark
      regionLabel={marks ? "待处理的审批与提问（演示）" : "待处理的审批与提问"}
      {...(onCurrentKind === undefined ? {} : { onCurrentKind })}
      {...(planExpanded === undefined ? {} : { planExpanded })}
      {...(onPlanExpandedChange === undefined ? {} : { onPlanExpandedChange })}
      {...(planOriginRef === undefined ? {} : { planOriginRef })}
    />
  );
}
