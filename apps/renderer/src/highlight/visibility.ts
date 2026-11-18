import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";

type IntersectionCallback = (intersecting: boolean) => void;

type SharedBucket = {
  observer: IntersectionObserver;
  targets: Map<Element, Set<IntersectionCallback>>;
};

const bucketsByDoc = new WeakMap<Document, Map<string, SharedBucket>>();

function observeShared(
  target: Element,
  rootMargin: string,
  callback: IntersectionCallback,
): (() => void) | undefined {
  const doc = target.ownerDocument;
  const view = doc?.defaultView as (Window & { IntersectionObserver?: typeof IntersectionObserver }) | null | undefined;
  const ObserverCtor = view?.IntersectionObserver ?? globalThis.IntersectionObserver;
  if (typeof ObserverCtor === "undefined" || !doc) return undefined;

  let docBuckets = bucketsByDoc.get(doc);
  if (!docBuckets) {
    docBuckets = new Map();
    bucketsByDoc.set(doc, docBuckets);
  }

  let bucket = docBuckets.get(rootMargin);
  if (!bucket) {
    const targets = new Map<Element, Set<IntersectionCallback>>();
    const observer = new ObserverCtor(
      (entries) => {
        for (const entry of entries) {
          const listeners = targets.get(entry.target);
          if (!listeners) continue;
          for (const listener of listeners) listener(entry.isIntersecting);
        }
      },
      rootMargin === "0px" ? undefined : { rootMargin },
    );
    bucket = { observer, targets };
    docBuckets.set(rootMargin, bucket);
  }

  let listeners = bucket.targets.get(target);
  if (!listeners) {
    listeners = new Set();
    bucket.targets.set(target, listeners);
    bucket.observer.observe(target);
  }
  listeners.add(callback);

  const activeBucket = bucket;
  const activeDocBuckets = docBuckets;
  return () => {
    const set = activeBucket.targets.get(target);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) {
      activeBucket.targets.delete(target);
      activeBucket.observer.unobserve(target);
      if (activeBucket.targets.size === 0) {
        activeBucket.observer.disconnect();
        activeDocBuckets.delete(rootMargin);
      }
    }
  };
}

/**
 * Tracks viewport (`0px`) and overscan (`240px`) intersection via shared document-level
 * observers. Returns a single `active` (`visible || near`) state to avoid cancelling
 * queued Worker jobs when scrolling from overscan into the viewport, while `visibleRef`
 * upgrades priority dynamically on the next pool pump.
 */
export function useHighlightVisibility(
  rootRef: RefObject<HTMLElement | null> | undefined,
  enabled = true,
): { active: boolean; visibleRef: MutableRefObject<boolean> } {
  const noObserver = typeof IntersectionObserver === "undefined" || rootRef === undefined;
  const visibleRef = useRef(noObserver);
  const [active, setActive] = useState(noObserver);

  useEffect(() => {
    if (!enabled) return;
    const target = rootRef?.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      visibleRef.current = true;
      setActive(true);
      return;
    }
    let isVis = false;
    let isNear = false;
    visibleRef.current = false;
    setActive(false);

    const stopVis = observeShared(target, "0px", (intersecting) => {
      isVis = intersecting;
      visibleRef.current = intersecting;
      setActive(isVis || isNear);
    });
    const stopNear = observeShared(target, "240px", (intersecting) => {
      isNear = intersecting;
      setActive(isVis || isNear);
    });
    if (!stopVis || !stopNear) {
      stopVis?.();
      stopNear?.();
      visibleRef.current = true;
      setActive(true);
      return;
    }
    return () => {
      stopVis();
      stopNear();
    };
  }, [rootRef, enabled]);

  return { active: noObserver ? true : active, visibleRef };
}
