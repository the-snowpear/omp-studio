import { useLayoutEffect, useRef } from "react";

/** Size tier of the top bar. `widthSource` is the full row when the top bar shares it with conversation tabs:
    there the top bar is only as wide as its own controls, so measuring itself would always land in "compact". */
export function useCompactTopbar(widthSource?: HTMLElement | null) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const source = widthSource ?? element;
    const sync = () => {
      const width = source.clientWidth;
      // Detached (an inactive conversation's top bar) or not laid out yet: keep the last tier.
      if (!width) return;
      const mode = width <= 520 ? "narrow" : width <= 1000 ? "compact" : "full";
      if (element.dataset.chromeSize !== mode) element.dataset.chromeSize = mode;
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    observer?.observe(source);
    return () => observer?.disconnect();
  }, [widthSource]);
  return ref;
}
