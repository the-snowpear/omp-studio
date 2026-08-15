import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Matches `--dur-slow`. Exit wait must equal the CSS page-out duration. */
export const PAGE_EXIT_MS = 250;

/** Matches `.tab-pane-enter-*` duration. Leave is shorter; this is the overlap window. */
export const TAB_PANE_MS = 320;

export type PagePhase = "in" | "out";
export type SlideDir = "fwd" | "back";
export type TabPaneRole = "enter" | "leave";

export function pageMotionReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function pagePhaseClass(phase: PagePhase): "page-in" | "page-out" {
  return phase === "out" ? "page-out" : "page-in";
}

export function tabPaneClass(role: TabPaneRole | null, dir: SlideDir): string {
  return role ? `tab-pane tab-pane-${role}-${dir}` : "tab-pane";
}

export function tabPaneRole<T>(id: T, incoming: T, outgoing: T | null, live: boolean): TabPaneRole | null {
  if (!live || outgoing == null) return null;
  if (Object.is(id, outgoing)) return "leave";
  if (Object.is(id, incoming)) return "enter";
  return null;
}

/**
 * Hold the previous key until the exit animation finishes, then swap and enter.
 * Rapid key changes cancel the pending swap so only the last destination lands.
 *
 * `phase` is derived from key vs shown, not stored and flipped in an effect.
 * Storing it lagged one paint: the outgoing view still had phase "in", so a
 * newly-armed `page-in` class restarted enter (opacity 0) before `page-out`
 * could run — a flash, then the exit animation.
 */
export function useDeferredKey<T>(key: T): { shown: T; phase: PagePhase } {
  const [shown, setShown] = useState(key);
  const gen = useRef(0);

  useEffect(() => {
    if (Object.is(key, shown)) return;
    const token = ++gen.current;
    const wait = pageMotionReduced() ? 0 : PAGE_EXIT_MS;
    const timer = window.setTimeout(() => {
      if (token !== gen.current) return;
      setShown(key);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [key, shown]);

  return { shown, phase: Object.is(key, shown) ? "in" : "out" };
}

/**
 * Hold a nullable editor/list value until the exit animation finishes.
 * `live` stays false on first mount so the list does not play enter on top
 * of the parent page/tab animation. Object identity changes while present
 * do not retrigger motion.
 */
export function useDeferredPresence<T>(value: T | null): {
  shown: T | null;
  phase: PagePhase;
  live: boolean;
} {
  const open = value !== null;
  const [present, setPresent] = useState(open);
  const [phase, setPhase] = useState<PagePhase>("in");
  const [live, setLive] = useState(false);
  const held = useRef<T | null>(value);
  const gen = useRef(0);
  if (value !== null) held.current = value;

  useEffect(() => {
    if (open === present) {
      setPhase((current) => (current === "in" ? current : "in"));
      return;
    }
    const token = ++gen.current;
    setLive(true);
    setPhase("out");
    const wait = pageMotionReduced() ? 0 : PAGE_EXIT_MS;
    const timer = window.setTimeout(() => {
      if (token !== gen.current) return;
      setPresent(open);
      setPhase("in");
    }, wait);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  return { shown: present ? held.current : null, phase, live };
}

/**
 * Overlay (modal) presence: mount immediately on open, keep the last value
 * through the exit animation, then unmount. Unlike {@link useDeferredPresence}
 * this does not delay the enter.
 */
export function useOverlayPresence<T>(value: T | null): {
  shown: T | null;
  leaving: boolean;
} {
  const open = value !== null;
  const held = useRef<T | null>(value);
  if (value !== null) held.current = value;
  const [present, setPresent] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const gen = useRef(0);

  useEffect(() => {
    if (open) {
      gen.current += 1;
      setPresent(true);
      setLeaving(false);
      return;
    }
    if (!present) return;
    setLeaving(true);
    const token = ++gen.current;
    const wait = pageMotionReduced() ? 0 : PAGE_EXIT_MS;
    const timer = window.setTimeout(() => {
      if (token !== gen.current) return;
      setPresent(false);
      setLeaving(false);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  return { shown: present ? held.current : null, leaving };
}

/**
 * Overlapping tab switch: the new pane mounts immediately while the previous
 * pane stays until {@link TAB_PANE_MS}, so CSS can crossfade them in one motion.
 * Each pane scrolls on its own (see `.tab-pane`); returning to a tab restores
 * its last scrollTop. `live` stays false on first mount so the panel does not
 * play enter on top of the page-level page-in.
 */
export function useOverlappingTabs<T>(key: T, index: number): {
  incoming: T;
  outgoing: T | null;
  dir: SlideDir;
  live: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
} {
  const [incoming, setIncoming] = useState(key);
  const [outgoing, setOutgoing] = useState<T | null>(null);
  const [dir, setDir] = useState<SlideDir>("fwd");
  const [live, setLive] = useState(false);
  const indexRef = useRef(index);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollMap = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    if (Object.is(key, incoming)) {
      indexRef.current = index;
      return;
    }
    const pane = stageRef.current?.querySelector(`[data-tab-pane="${String(incoming)}"]`);
    if (pane instanceof HTMLElement) scrollMap.current.set(String(incoming), pane.scrollTop);
    setDir(index >= indexRef.current ? "fwd" : "back");
    indexRef.current = index;
    setLive(true);
    if (pageMotionReduced()) {
      setIncoming(key);
      setOutgoing(null);
      return;
    }
    setOutgoing(incoming);
    setIncoming(key);
  }, [key, incoming, index]);

  useLayoutEffect(() => {
    const pane = stageRef.current?.querySelector(`[data-tab-pane="${String(incoming)}"]`);
    if (!(pane instanceof HTMLElement)) return;
    const y = scrollMap.current.get(String(incoming));
    if (y != null) pane.scrollTop = y;
  }, [incoming]);

  useEffect(() => {
    if (outgoing == null) return;
    const timer = window.setTimeout(() => setOutgoing(null), TAB_PANE_MS);
    return () => window.clearTimeout(timer);
  }, [outgoing, incoming]);

  return { incoming, outgoing, dir, live, stageRef };
}
