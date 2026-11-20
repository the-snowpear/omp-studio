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
  skipSignal,
  planExpanded,
  onPlanExpandedChange,
  planOriginRef,
}: {
  skipSignal?: number;
  onCurrentKind?: (kind: "plan" | "ask" | null) => void;
  planExpanded?: boolean;
  onPlanExpandedChange?: (open: boolean) => void;
  planOriginRef?: RefObject<HTMLElement | null>;
} = {}) {
  const { marks } = usePreviewMode();
  const zh = useI18n().resolvedLanguage === "zh";
  const sessionsRef = useRef<Map<string, FormSession>>(new Map());
  const mounting = useRef(0);
  const deckFixtures = useMemo(() => getPreviewDeckItems(zh), [zh]);
  const items = useMemo<readonly QueuedDeckItem[]>(() => deckFixtures.map(item => {
    if (item.kind !== "form") return item;
    let session = sessionsRef.current.get(item.id);
    if (!session) {
      session = new FormSession({ kind: "form", interactionId: item.id as InteractionId, sessionId: "preview:deck" as SessionId, leaseGeneration: 1, title: item.title, summary: item.summary, fieldCount: item.form.fields.length, sectionCount: item.form.sections.length });
      sessionsRef.current.set(item.id, session);
    } else if (session.form !== undefined && session.getMeta().phase !== "closed") {
      session.form = item.form;
    }
    return { kind: "form", id: item.id, title: item.title, summary: item.summary, session, ...(item.meta ? { meta: item.meta } : {}) };
  }), [deckFixtures]);
  useEffect(() => {
    for (const item of items) {
      if (item.kind !== "form") continue;
      const fixture = deckFixtures.find(candidate => candidate.id === item.id);
      if (fixture?.kind === "form") {
        if (item.session.form !== undefined && item.session.getMeta().phase !== "closed") {
          item.session.form = fixture.form;
        } else {
          void item.session.load(() => Promise.resolve(fixture.form));
        }
      }
    }
  }, [items, deckFixtures]);
  useEffect(() => {
    const generation = ++mounting.current;
    return () => { queueMicrotask(() => {
      // StrictMode's effect replay is not a terminal preview lifecycle.
      if (mounting.current !== generation) return;
      for (const session of sessionsRef.current.values()) session.close();
      sessionsRef.current.clear();
    }); };
  }, []);
  return (
    <QueuedDeck skipSignal={skipSignal}
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
