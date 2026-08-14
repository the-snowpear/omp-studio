import { useEffect, useRef, useState } from "react";

/** Matches `--dur-slow`. Exit wait must equal the CSS page-out duration. */
export const PAGE_EXIT_MS = 250;

export type PagePhase = "in" | "out";

export function pageMotionReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function pagePhaseClass(phase: PagePhase): "page-in" | "page-out" {
  return phase === "out" ? "page-out" : "page-in";
}

/**
 * Hold the previous key until the exit animation finishes, then swap and enter.
 * Rapid key changes cancel the pending swap so only the last destination lands.
 */
export function useDeferredKey<T>(key: T): { shown: T; phase: PagePhase } {
  const [shown, setShown] = useState(key);
  const [phase, setPhase] = useState<PagePhase>("in");
  const gen = useRef(0);

  useEffect(() => {
    if (Object.is(key, shown)) {
      setPhase((current) => (current === "in" ? current : "in"));
      return;
    }
    const token = ++gen.current;
    setPhase("out");
    const wait = pageMotionReduced() ? 0 : PAGE_EXIT_MS;
    const timer = window.setTimeout(() => {
      if (token !== gen.current) return;
      setShown(key);
      setPhase("in");
    }, wait);
    return () => window.clearTimeout(timer);
  }, [key, shown]);

  return { shown, phase };
}
