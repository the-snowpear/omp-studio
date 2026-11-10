import { useCallback, useRef, useState } from "react";

/**
 * Narrow / wide tier of a panel body, measured on the element itself.
 *
 * Dock bodies are sized by PanelHosts: the same body can be a 320px rail card,
 * a half-screen window or a full-screen group (DockFullscreen), so a layout
 * switch has to follow the body's own width rather than the window's. Panels
 * that change structure when wide (a list beside a detail pane, an inspector
 * column) read this; panels that only restyle use container queries instead.
 *
 * Returns a callback ref, so an element that mounts late (after a loading
 * state) is still observed. `band` is a dead zone below `min` so a resize that
 * settles on the boundary does not flip the layout back and forth. Hidden or
 * detached elements (zero width) keep their last tier; without ResizeObserver
 * (tests) it stays narrow.
 */
export function useWideLayout<T extends HTMLElement>(min: number, band = 24): [(element: T | null) => void, boolean] {
  const [wide, setWide] = useState(false);
  const tier = useRef(false);
  const detach = useRef<(() => void) | undefined>(undefined);
  const ref = useCallback((element: T | null) => {
    detach.current?.();
    detach.current = undefined;
    if (!element) return;
    const sync = () => {
      const width = element.clientWidth;
      if (!width) return;
      const next = tier.current ? width >= min - band : width >= min;
      if (next === tier.current) return;
      tier.current = next;
      setWide(next);
    };
    sync();
    // Bodies can live in a native float window: observe with that document's own constructor.
    const Observer = element.ownerDocument.defaultView?.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
    if (!Observer) return;
    const observer = new Observer(sync);
    observer.observe(element);
    detach.current = () => observer.disconnect();
  }, [min, band]);
  return [ref, wide];
}
