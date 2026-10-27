import { useLayoutEffect, useRef } from "react";

export function useCompactTopbar() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const sync = () => {
      const width = element.clientWidth;
      const mode = width <= 520 ? "narrow" : width <= 1000 ? "compact" : "full";
      if (element.dataset.chromeSize !== mode) element.dataset.chromeSize = mode;
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  return ref;
}
