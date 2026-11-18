import { useEffect, useState, type RefObject } from "react";

const SCROLL_SETTLE_MS = 140;

/** Visibility changes and async results must not initialize a viewer during a scroll gesture. */
export function afterPreviewScroll(host: HTMLElement | null | undefined, work: () => void): () => void {
  const document = host?.ownerDocument;
  const window = document?.defaultView;
  if (!host || !document || !window) return () => {};
  let timer: number;
  const dispose = () => {
    window.clearTimeout(timer);
    document.removeEventListener("scroll", scrolled, true);
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { dispose(); work(); }, SCROLL_SETTLE_MS);
  };
  const scrolled = (event: Event) => {
    const target = event.target;
    if (host === document.documentElement || target instanceof window.Node && target.contains(host)) schedule();
  };
  document.addEventListener("scroll", scrolled, { capture: true, passive: true });
  schedule();
  return dispose;
}

/** `once` keeps static figures intact after their first render. GPU viewers still release offscreen. */
export function usePreviewVisibility(host: RefObject<HTMLElement | null>, once = false): boolean {
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = host.current;
    const ObserverCtor = globalThis.IntersectionObserver ?? node?.ownerDocument?.defaultView?.IntersectionObserver;
    if (!node || typeof ObserverCtor === "undefined") return;
    let cancel = () => {};
    const observer = new ObserverCtor(entries => {
      const next = entries.some(entry => entry.isIntersecting);
      cancel();
      cancel = afterPreviewScroll(node, () => {
        setVisible(next);
        if (next && once) observer.disconnect();
      });
    }, { rootMargin: "240px" });
    observer.observe(node);
    return () => { cancel(); observer.disconnect(); };
  }, [host, once]);
  return visible;
}
