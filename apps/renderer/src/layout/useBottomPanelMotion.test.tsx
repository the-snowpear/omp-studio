import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBottomPanelMotion } from "./useBottomPanelMotion";

/** jsdom 没有布局也没有 WAAPI：面板给一个可调高度，动画给一个能手动结束的壳。 */
type FakeAnimation = { frames: Keyframe[]; options: KeyframeAnimationOptions; onfinish: (() => void) | null; oncancel: (() => void) | null };

function harness() {
  const height = { value: 240 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 400, this.classList.contains("bottom-panel") ? height.value : 0);
  });
  const animations: FakeAnimation[] = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation: FakeAnimation = {
        frames, options, onfinish: null, oncancel: null,
        cancel: () => animation.oncancel?.(),
      } as FakeAnimation & { cancel: () => void };
      animations.push(animation);
      return animation as unknown as Animation;
    },
  });
  return { height, animations };
}

function Probe({ visible, expanded, suspended = false }: { visible: boolean; expanded: boolean; suspended?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useBottomPanelMotion(ref, visible, expanded, suspended);
  return <div ref={ref} className="bottom-panel" data-shown={`${shown.visible}:${shown.expanded}`} />;
}

function shown(container: HTMLElement) {
  return container.firstElementChild?.getAttribute("data-shown");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  delete document.documentElement.dataset.perfTier;
});

describe("bottom panel motion", () => {
  it("animates the height and keeps the body on screen while it closes", () => {
    const { height, animations } = harness();
    const view = render(<Probe visible expanded />);
    height.value = 0;
    view.rerender(<Probe visible={false} expanded={false} />);
    expect(animations).toHaveLength(1);
    expect(animations[0]!.frames).toEqual([{ height: "240px" }, { height: "0px" }]);
    expect(animations[0]!.options.duration).toBe(250);
    // 收起途中仍是旧结构：正文跟着面板一起被裁掉，而不是第一帧就整块消失。
    expect(shown(view.container)).toBe("true:true");
    act(() => animations[0]!.onfinish!());
    expect(shown(view.container)).toBe("false:false");
  });

  it("opens from the resting height without retracting anything", () => {
    const { height, animations } = harness();
    height.value = 36;
    const view = render(<Probe visible expanded={false} />);
    height.value = 240;
    view.rerender(<Probe visible expanded />);
    expect(animations).toHaveLength(1);
    expect(animations[0]!.frames).toEqual([{ height: "36px" }, { height: "240px" }]);
    expect(shown(view.container)).toBe("true:true");
  });

  it("does not animate under reduced motion or while the resizer drags", () => {
    const { height, animations } = harness();
    const view = render(<Probe visible expanded />);
    document.documentElement.dataset.perfTier = "L1";
    height.value = 0;
    view.rerender(<Probe visible={false} expanded={false} />);
    expect(animations).toHaveLength(0);
    expect(shown(view.container)).toBe("false:false");
    delete document.documentElement.dataset.perfTier;
    height.value = 240;
    view.rerender(<Probe visible expanded suspended />);
    expect(animations).toHaveLength(0);
  });
});
