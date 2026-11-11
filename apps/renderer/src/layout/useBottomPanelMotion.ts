import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MOTION_EASE, MOTION_MS, motionReduced } from "../motion";

/** 底栏这一刻该按什么结构渲染（`visible` = 整条在屏，`expanded` = 正文展开）。 */
export type BottomPanelPresentation = { readonly visible: boolean; readonly expanded: boolean };

/** 半像素以内的高低差做不出看得见的动画，直接换。 */
const MIN_TRAVEL = 0.5;

/** 一块区域改变大小：--dur-slow · --ease-out（styles/motion.css 的 region）。减少动效时不做动画。 */
function motionTokens(): { duration: number; easing: string } | null {
  return motionReduced() ? null : { duration: MOTION_MS.slow, easing: MOTION_EASE.out };
}

/**
 * 底栏收起/展开时补一段高度动画。
 *
 * 工作台故意不给 `.bottom-panel` 挂 CSS 过渡：窗口缩放、拖拽调高和布局求解每帧都在写
 * 高度，过渡只会让面板追着光标跑。所以这里只在「整条显示/隐藏」「正文折叠/展开」
 * 这类状态翻转时，用 WAAPI 直接驱动面板高度：逐帧不经过 React，缩放和拖拽仍是直接换高。
 *
 * 收起时返回上一帧的 `visible/expanded`，让正文跟着面板一起被裁掉；
 * 否则正文会在第一帧整块消失，只剩一条空壳在收。
 */
export function useBottomPanelMotion(
  panel: RefObject<HTMLElement | null>,
  visible: boolean,
  expanded: boolean,
  suspended = false,
): BottomPanelPresentation {
  const [retained, setRetained] = useState<BottomPanelPresentation | null>(null);
  /** 没有动画时的静止高度：窗口缩放、拖拽调高都落在这里。 */
  const resting = useRef(0);
  const running = useRef<Animation | null>(null);
  const previous = useRef<BottomPanelPresentation | null>(null);

  useLayoutEffect(() => {
    const element = panel.current;
    if (element === null) return;
    const read = () => {
      if (running.current === null) resting.current = element.getBoundingClientRect().height;
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel]);

  useLayoutEffect(() => {
    const element = panel.current;
    const before = previous.current;
    previous.current = { visible, expanded };
    if (element === null) return;
    if (suspended) {
      // 拖拽调高直接写内联高度；动画压在上面只会让面板追不上光标。
      running.current?.cancel();
      running.current = null;
      setRetained(null);
      resting.current = element.getBoundingClientRect().height;
      return;
    }
    if (before === null) return;
    const animated = running.current;
    // 动画途中再翻转：取消会跳回新状态的终值，所以先量中途的真实高度。
    const current = animated === null ? null : element.getBoundingClientRect().height;
    animated?.cancel();
    running.current = null;
    const target = element.getBoundingClientRect().height;
    const from = current ?? resting.current;
    resting.current = target;
    const tokens = motionTokens();
    if (tokens === null || Math.abs(target - from) < MIN_TRAVEL || typeof element.animate !== "function") {
      setRetained(null);
      return;
    }
    const closing = (!visible && before.visible) || (!expanded && before.expanded);
    setRetained(closing ? before : null);
    const animation = element.animate(
      [{ height: `${from}px` }, { height: `${target}px` }],
      { duration: tokens.duration, easing: tokens.easing },
    );
    running.current = animation;
    animation.onfinish = () => {
      if (running.current !== animation) return;
      running.current = null;
      resting.current = element.getBoundingClientRect().height;
      setRetained(null);
    };
    animation.oncancel = () => {
      if (running.current === animation) running.current = null;
    };
  }, [panel, visible, expanded, suspended]);

  return {
    visible: visible || (retained?.visible ?? false),
    expanded: expanded || (retained?.expanded ?? false),
  };
}
