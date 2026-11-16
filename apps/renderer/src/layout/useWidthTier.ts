import { useCallback, useRef, useState } from "react";

/**
 * Several-step sibling of `useWideLayout`: which width tier a panel body is in.
 *
 * `steps` are ascending minimum widths; the result is how many of them the
 * body clears (0 = narrower than the first). Like `useWideLayout` it measures
 * the element itself, keeps a `band` dead zone below each step so a resize that
 * settles on a boundary does not flip back and forth, holds the last tier while
 * the body is hidden (zero width), and stays at 0 without ResizeObserver.
 */
export function useWidthTier<T extends HTMLElement>(steps: readonly number[], band = 24): [(element: T | null) => void, number, number] {
  const [state, setState] = useState({ tier: 0, width: 0 });
  const tier = useRef(0);
  const detach = useRef<(() => void) | undefined>(undefined);
  const key = steps.join(",");
  const ref = useCallback((element: T | null) => {
    detach.current?.();
    detach.current = undefined;
    if (!element) return;
    const sync = () => {
      const width = element.clientWidth;
      if (!width) return;
      let next = 0;
      steps.forEach((min, index) => { if (width >= (tier.current > index ? min - band : min)) next = index + 1; });
      tier.current = next;
      setState(previous => previous.tier === next && Math.abs(previous.width - width) < 8 ? previous : { tier: next, width });
    };
    sync();
    const Observer = element.ownerDocument.defaultView?.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
    if (!Observer) return;
    const observer = new Observer(sync);
    observer.observe(element);
    detach.current = () => observer.disconnect();
  // `key` is the value identity of `steps`, so a fresh array literal each render does not re-observe.
  }, [key, band]);
  return [ref, state.tier, state.width];
}
