import { useCallback, useEffect, useRef } from "react";
import { snapshotIsEmpty } from "./serialize";
import type { ComposerSnapshot } from "./types";

const DRAFT_PUBLISH_MS = 140;

/** Only empty/content, image and capsule boundaries need an immediate render. */
function draftStatus(snapshot: ComposerSnapshot): number {
  return (snapshotIsEmpty(snapshot) ? 1 : 0)
    | (snapshot.images.length > 0 ? 2 : 0)
    | (snapshot.doc.nodes.some(node => node.type === "chip") ? 4 : 0);
}

/** Exact live draft, with a trailing render publication while typing. */
export function useComposerDraft(initial: ComposerSnapshot, onPublish: (snapshot: ComposerSnapshot) => void) {
  const draftLive = useRef(initial);
  const publishedStatus = useRef<number | undefined>(undefined);
  if (publishedStatus.current === undefined) publishedStatus.current = draftStatus(initial);
  const publishTo = useRef(onPublish);
  publishTo.current = onPublish;
  const timer = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current === 0) return;
    window.clearTimeout(timer.current);
    timer.current = 0;
  }, []);

  const publishDraft = useCallback((next: ComposerSnapshot, immediate = false) => {
    draftLive.current = next;
    cancel();
    const status = draftStatus(next);
    if (immediate || status !== publishedStatus.current) {
      publishedStatus.current = status;
      publishTo.current(next);
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      publishedStatus.current = status;
      publishTo.current(draftLive.current);
    }, DRAFT_PUBLISH_MS);
  }, [cancel]);

  const commitDraft = useCallback((next: ComposerSnapshot) => publishDraft(next, true), [publishDraft]);
  useEffect(() => cancel, [cancel]);

  return { draftLive, publishDraft, commitDraft };
}
