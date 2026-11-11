import { useLayoutEffect, useRef } from "react";

export function useComposerCollisionCollapse() {
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    let frame: number | undefined;
    let disposed = false;
    const hasPressure = () => {
      bar.dataset.measuring = "true";
      const modes = bar.querySelector<HTMLElement>(".cmp-mode-cluster");
      // Measure in-flow controls, not scrollWidth: open menus extend beyond the
      // bar, and the mode cluster can be absent even when the send button spills.
      const right = bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight);
      const pressured = Array.from(bar.children).some((child) => child.getBoundingClientRect().right > right + 1)
        || (modes !== null && modes.scrollWidth > modes.clientWidth + 1);
      delete bar.dataset.measuring;
      return pressured;
    };
    const measure = () => {
      frame = undefined;
      // Resetting collapse to "full" then back reflows the bar. Do not do that
      // while a menu is open unless resizing has pushed controls out of bounds.
      if (bar.querySelector("[aria-expanded='true']") && !hasPressure()) return;
      // 无变化不写：本 hook 自己观察着这个 bar（ResizeObserver），无条件改写
      // data-collapse 会触发布局变化又把观察者唤醒，形成 rAF 级自持循环。
      const setCollapse = (value: string) => {
        if (bar.dataset.collapse !== value) bar.dataset.collapse = value;
      };
      setCollapse("full");
      if (!hasPressure()) return;
      setCollapse("tools");
      if (!hasPressure()) return;
      setCollapse("compact");
      if (!hasPressure()) return;
      setCollapse("minimal");
    };
    const schedule = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    resizeObserver?.observe(bar);
    const mutationObserver = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(schedule);
    mutationObserver?.observe(bar, { childList: true, characterData: true, subtree: true });
    void document.fonts?.ready.then(() => {
      if (!disposed) schedule();
    });

    return () => {
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  return barRef;
}
