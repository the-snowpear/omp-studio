import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { InteractionId, SessionId } from "@omp-studio/client-contract";
import { FormSession } from "../deck/FormSession";
import { QueuedDeck, type QueuedDeckItem } from "../deck/QueuedDeck";
import { useI18n } from "../i18n";
import { getPreviewDeckItems } from "./deckFixtures";
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
  const zh = useI18n().resolvedLanguage === "zh";
  const deckFixtures = useMemo(() => getPreviewDeckItems(zh), [zh]);
  const items = useMemo<readonly QueuedDeckItem[]>(() => deckFixtures.map(item => {
    if (item.kind !== "form") return item;
    const session = new FormSession({ kind: "form", interactionId: item.id as InteractionId, sessionId: "preview:deck" as SessionId, leaseGeneration: 1, title: item.title, summary: item.summary, fieldCount: item.form.fields.length, sectionCount: item.form.sections.length });
    return { kind: "form", id: item.id, title: item.title, summary: item.summary, session, ...(item.meta ? { meta: item.meta } : {}) };
  }), [deckFixtures]);
  const mounting = useRef(0);
  useEffect(() => {
    const generation = ++mounting.current;
    for (const item of items) {
      if (item.kind !== "form") continue;
      const fixture = deckFixtures.find(candidate => candidate.id === item.id);
      if (fixture?.kind === "form") void item.session.load(() => Promise.resolve(fixture.form));
    }
    return () => { queueMicrotask(() => {
      // StrictMode's effect replay is not a terminal preview lifecycle.
      if (mounting.current !== generation) return;
      for (const item of items) if (item.kind === "form") item.session.close();
    }); };
  }, [items, deckFixtures]);
  return (
    <QueuedDeck
      items={items}
      demo={marks}
      previewMark={marks}
      regionLabel={zh ? (marks ? "待处理的审批与提问（演示）" : "待处理的审批与提问") : (marks ? "Pending approvals and questions (Demo)" : "Pending approvals and questions")}
      {...(onCurrentKind === undefined ? {} : { onCurrentKind })}
      {...(planExpanded === undefined ? {} : { planExpanded })}
      {...(onPlanExpandedChange === undefined ? {} : { onPlanExpandedChange })}
      {...(planOriginRef === undefined ? {} : { planOriginRef })}
    />
  );
}
