import { QueuedDeck } from "../deck/QueuedDeck";
import { PREVIEW_DECK_ITEMS } from "./deckFixtures";

/**
 * Preview-only Deck above the composer. One window, ver1-style 1/N queue.
 * Demo buttons dismiss local cards; they do not call Host, write the reducer,
 * or forge SurfaceCapabilities. Live Ask uses the same QueuedDeck shell.
 */
export function PreviewDeck({ onCurrentKind }: {
  onCurrentKind?: (kind: "plan" | "ask" | null) => void;
} = {}) {
  return (
    <QueuedDeck
      items={PREVIEW_DECK_ITEMS}
      demo
      previewMark
      regionLabel="待处理的审批与提问（演示）"
      {...(onCurrentKind === undefined ? {} : { onCurrentKind })}
    />
  );
}
