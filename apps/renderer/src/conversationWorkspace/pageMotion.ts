import { useLayoutEffect, useRef } from "react";
import { MOTION_EASE, MOTION_MS, motionReduced } from "../motion";
import { PAGE_EXIT_MS, type PagePhase } from "../pageTransition";

/**
 * The workbench half of a workbench ↔ page swap. Its surfaces live in several
 * slots (sidebar, title row, conversation, panels, floating windows), so one
 * registered property on the root dims them together instead of a class on each.
 * The workbench is the ground level (styles/motion.css): it dissolves in place
 * for the same PAGE_EXIT_MS the page waits, and returns on the page's own
 * arrival clock.
 */
export function useWorkbenchPageMotion(page: boolean, phase: PagePhase) {
  const previous = useRef({ page, phase });
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { page, phase };
    const entering = before.page && !page;
    const leaving = !page && phase === "out";
    const returning = !page && before.phase === "out" && phase === "in";
    const root = document.documentElement;
    const opacity = entering ? "0" : getComputedStyle(root).getPropertyValue("--cw-route-opacity").trim() || "1";
    animation.current?.cancel();
    animation.current = null;
    root.toggleAttribute("data-workbench-transition", !page && (entering || leaving || returning));
    if (page || !(entering || leaving || returning) || motionReduced() || typeof root.animate !== "function") {
      root.removeAttribute("data-workbench-transition");
      return;
    }
    const motion = root.animate(
      [{ "--cw-route-opacity": opacity }, { "--cw-route-opacity": leaving ? "0" : "1" }],
      leaving
        ? { duration: PAGE_EXIT_MS, easing: MOTION_EASE.standard, fill: "forwards" }
        : { duration: MOTION_MS.slower, easing: MOTION_EASE.nav, fill: "forwards" },
    );
    animation.current = motion;
    motion.onfinish = () => {
      if (animation.current !== motion || leaving) return;
      root.removeAttribute("data-workbench-transition");
      motion.cancel();
      animation.current = null;
    };
  }, [page, phase]);
  useLayoutEffect(() => () => { animation.current?.cancel(); document.documentElement.removeAttribute("data-workbench-transition"); }, []);
}
