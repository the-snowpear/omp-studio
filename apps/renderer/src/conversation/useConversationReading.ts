import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ConversationSnapshot } from "./conversationEngine";
import { timelineRowKey } from "./conversationViewModel";
import { captureAnchor, type ScrollAnchor } from "./useConversationScroll";
import { revealConversationTarget } from "./conversationReveal";

/** Only scalar anchors survive a released view, never transcript rows or DOM. */
export type ConversationReadingMemory = {
  reading?: { anchor: ScrollAnchor | null; following: boolean; rows: number; conversationSessionId?: string };
};

export function useConversationReading({ memory, visible, snapshot, scrollerRef, follow, detachFromLatest, loadOlder, beforeDetach }: {
  memory: ConversationReadingMemory | undefined;
  visible: boolean;
  snapshot: Pick<ConversationSnapshot, "state" | "rows" | "loadingOlder">;
  scrollerRef: RefObject<HTMLElement | null>;
  follow: boolean;
  detachFromLatest(): void;
  loadOlder(): void;
  beforeDetach?: ((save: () => void) => () => void) | undefined;
}) {
  const pending = useRef(memory?.reading);
  const restored = useRef(false);
  const previousCount = useRef(-1);
  const lifetime = useRef(0);
  const current = useRef({ snapshot, follow });
  current.current = { snapshot, follow };
  const save = useCallback(() => {
    const scroller = scrollerRef.current, value = current.current;
    // Portal removal zeroes geometry before React's child cleanup can run.
    // The host calls this while connected; later cleanup must not overwrite it.
    if (memory && scroller?.isConnected && scroller.scrollHeight > 0 && restored.current && value.snapshot.rows.length) {
      memory.reading = { anchor: captureAnchor(scroller), following: value.follow, rows: value.snapshot.rows.length,
        ...(value.snapshot.state.identity?.sessionId === undefined ? {} : { conversationSessionId: value.snapshot.state.identity.sessionId }) };
    }
  }, [memory, scrollerRef]);
  useLayoutEffect(() => {
    lifetime.current++;
    if (visible && memory) pending.current = memory.reading;
    return () => {
      save();
      lifetime.current++;
      restored.current = false;
      previousCount.current = -1;
    };
  }, [visible, memory, save]);
  useLayoutEffect(() => beforeDetach?.(save), [beforeDetach, save]);
  useEffect(() => {
    const refreshing = snapshot.state.hydrateStatus === "loading" || snapshot.state.hydrateStatus === "resyncing";
    if (refreshing && snapshot.rows.length === 0) {
      restored.current = false;
      previousCount.current = -1;
    }
    const ready = snapshot.state.hydrateStatus === "ready";
    if (!visible || !memory || (!ready && !(refreshing && snapshot.rows.length > 0)) || snapshot.loadingOlder || restored.current) return;
    const reading = pending.current;
    if (!reading || reading.following || (reading.conversationSessionId && reading.conversationSessionId !== snapshot.state.identity?.sessionId)) {
      restored.current = true;
      return;
    }
    const anchor = reading.anchor;
    // Re-read older pages only until the anchor is found or Store retention stops growing.
    if (anchor?.itemId && !snapshot.rows.some(row => timelineRowKey(row) === anchor.itemId) && snapshot.state.hasMoreBefore && snapshot.state.items.length > previousCount.current) {
      if (!ready) return; // Cached cursors must be revalidated before backfilling.
      previousCount.current = snapshot.state.items.length;
      loadOlder();
      return;
    }
    detachFromLatest();
    restored.current = true;
    const token = lifetime.current;
    // The virtualizer may flush a row mount. Run outside React's effect commit.
    if (anchor) queueMicrotask(() => {
      if (token !== lifetime.current) return;
      void revealConversationTarget(scrollerRef.current, { itemId: anchor.itemId, offset: anchor.offset, flash: false }).then(found => {
        if (!found && token === lifetime.current && scrollerRef.current) scrollerRef.current.scrollTop = anchor.scrollTop;
      });
    });
  }, [visible, memory, snapshot, detachFromLatest, loadOlder, scrollerRef]);
}
