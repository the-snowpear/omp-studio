import { useLayoutEffect, useRef } from "react";
import { PAGE_EXIT_MS, pageMotionReduced, type PagePhase } from "../pageTransition";

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
    if (page || !(entering || leaving || returning) || pageMotionReduced() || typeof root.animate !== "function") {
      root.removeAttribute("data-workbench-transition");
      return;
    }
    const motion = root.animate([{ "--cw-route-opacity": opacity }, { "--cw-route-opacity": leaving ? "0" : "1" }], { duration: PAGE_EXIT_MS, easing: "ease", fill: "forwards" });
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
