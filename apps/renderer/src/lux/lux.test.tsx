import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LuxAmbient } from "./LuxAmbient";
import { LuxOrbit } from "./LuxOrbit";
import { applyLightLevel } from "./lightLevel";

afterEach(() => {
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
});
