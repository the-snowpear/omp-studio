import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LuxAmbient } from "./LuxAmbient";
import { LuxOrbit } from "./LuxOrbit";
import { LuxSpotlight } from "./LuxSpotlight";
import { applyLightLevel } from "./lightLevel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-light");
});

describe("light layer", () => {
  it("writes each level as the set of layers it includes", () => {
    const root = document.documentElement;
    applyLightLevel(root, "off");
    expect(root.getAttribute("data-light")).toBe("off");
    applyLightLevel(root, "vivid");
    expect(root.getAttribute("data-light")).toBe("vivid std soft");
  });

  it("lights the composer only while the agent works, and the ambient field follows the strongest state", () => {
    const view = render(
      <>
        <div className="composer"><LuxOrbit state="idle" /></div>
        <LuxAmbient />
      </>,
    );
    const ambient = () => view.container.querySelector(".lux-ambient")?.getAttribute("data-activity");
    expect(view.container.querySelector(".lux-orbit")).toBeNull();
    expect(ambient()).toBe("idle");

    act(() => {
      view.rerender(
        <>
          <div className="composer"><LuxOrbit state="running" /></div>
          <div className="composer"><LuxOrbit state="waiting" /></div>
          <LuxAmbient />
        </>,
      );
    });
    expect(view.container.querySelectorAll(".lux-orbit")).toHaveLength(2);
    expect(ambient()).toBe("waiting");

    view.unmount();
    const fresh = render(<LuxAmbient />);
    expect(fresh.container.querySelector(".lux-ambient")?.getAttribute("data-activity")).toBe("idle");
  });

  it("keeps the spotlight on the same card after its layout changes", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const view = render(<><div className="card" /><LuxSpotlight enabled /></>);
    const card = view.container.querySelector<HTMLElement>(".card")!;
    const spot = view.container.querySelector<HTMLElement>(".lux-spot")!;
    let rect = new DOMRect(28, 266, 230, 76);
    vi.spyOn(card, "getBoundingClientRect").mockImplementation(() => rect);
    const move = (x: number, y: number) => {
      fireEvent.pointerMove(card, { clientX: x, clientY: y });
      act(() => { frames.shift()!(0); });
    };

    move(100, 300);
    expect(spot.style.translate).toBe("28px 266px");

    rect = new DOMRect(90, 300, 280, 90);
    move(100, 330);
    expect(spot.style.translate).toBe("90px 300px");
    expect(spot.style.width).toBe("280px");
    expect(spot.style.height).toBe("90px");
    expect(spot.style.getPropertyValue("--mx")).toBe("10px");
    expect(spot.style.getPropertyValue("--my")).toBe("30px");

    fireEvent.resize(window);
    expect(spot.hasAttribute("data-on")).toBe(false);
    rect = new DOMRect(90, 340, 280, 90);
    move(100, 350);
    expect(spot.style.translate).toBe("90px 340px");
    expect(spot.hasAttribute("data-on")).toBe(true);
  });
});
