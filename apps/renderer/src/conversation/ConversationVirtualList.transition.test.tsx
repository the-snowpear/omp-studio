import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationVirtualList } from "./ConversationVirtualList";

/** jsdom 没有实现 TransitionEvent 构造器：用普通 Event 补 propertyName 字段。 */
function transitionEvent(type: string, propertyName: string): Event {
  const event = new Event(type);
  Object.defineProperty(event, "propertyName", { value: propertyName });
  return event;
}

/** 高度动画门控（bug：展开/收起工具卡时无关行连跳）。动画在播期间列表持有
 *  .is-height-animating，行的 translateY 由短过渡补帧；动画结束即撤。 */
describe("ConversationVirtualList height-animation gate", () => {
  afterEach(cleanup);

  function mountedHost(): HTMLElement {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    const { container } = render(
      <ConversationVirtualList
        scrollerRef={{ current: scroller }}
        itemKeys={["row-a", "row-b"]}
        renderItem={(index) => <div>{`row ${index}`}</div>}
      />,
    );
    const host = container.querySelector<HTMLElement>(".convo-virtual-list");
    expect(host).not.toBeNull();
    return host!;
  }

  it("arms on a grid-template-rows transition and disarms after it ends", async () => {
    const host = mountedHost();
    expect(host.classList.contains("is-height-animating")).toBe(false);
    act(() => { host.dispatchEvent(transitionEvent("transitionrun", "grid-template-rows")); });
    expect(host.classList.contains("is-height-animating")).toBe(true);
    act(() => { host.dispatchEvent(transitionEvent("transitionend", "grid-template-rows")); });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(host.classList.contains("is-height-animating")).toBe(false);
  });

  it("ignores transitions that do not come from row-height animations", () => {
    const host = mountedHost();
    act(() => { host.dispatchEvent(transitionEvent("transitionrun", "transform")); });
    act(() => { host.dispatchEvent(transitionEvent("transitionrun", "opacity")); });
    expect(host.classList.contains("is-height-animating")).toBe(false);
  });

  it("disarms on cancel as well, so an interrupted animation cannot leave the gate stuck", async () => {
    const host = mountedHost();
    act(() => { host.dispatchEvent(transitionEvent("transitionrun", "grid-template-rows")); });
    expect(host.classList.contains("is-height-animating")).toBe(true);
    act(() => { host.dispatchEvent(transitionEvent("transitioncancel", "grid-template-rows")); });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(host.classList.contains("is-height-animating")).toBe(false);
  });
});
