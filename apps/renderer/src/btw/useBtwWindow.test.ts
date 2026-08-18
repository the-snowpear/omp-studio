import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BTW_DRAG_THRESHOLD } from "./btwGeometry";
import { useBtwWindow, type BtwPointerLike } from "./useBtwWindow";

afterEach(cleanup);

function pointer(node: HTMLElement, x: number, y: number): BtwPointerLike {
  return {
    pointerId: 1,
    clientX: x,
    clientY: y,
    currentTarget: node,
    preventDefault() {},
  };
}

function fire(node: HTMLElement, type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "clientX", { value: x });
  Object.defineProperty(event, "clientY", { value: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "preventDefault", { value: () => {} });
  node.dispatchEvent(event);
}

function surface(className: string): HTMLElement {
  const root = document.createElement("div");
  root.className = className;
  const grip = document.createElement("div");
  root.appendChild(grip);
  document.body.appendChild(root);
  return grip;
}

describe("useBtwWindow", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.body.classList.remove("is-btw-dragging");
  });

  it("starts floating and closed, then docks and undocks", () => {
    const docks: number[] = [];
    const { result } = renderHook(() =>
      useBtwWindow({
        sideOpen: false,
        sideHeadRect: () => undefined,
        onDock: () => {
          docks.push(1);
        },
      }),
    );
    expect(result.current.open).toBe(false);
    expect(result.current.placement).toBe("float");
    act(() => {
      result.current.show();
      result.current.dock();
    });
    expect(result.current.open).toBe(true);
    expect(result.current.placement).toBe("docked");
    expect(result.current.minimized).toBe(false);
    expect(docks).toEqual([1]);
    act(() => result.current.undock({ x: 200, y: 80 }));
    expect(result.current.placement).toBe("float");
  });

  it("minimizes and restores the floating window", () => {
    const { result } = renderHook(() => useBtwWindow({ sideOpen: false, sideHeadRect: () => undefined }));
    act(() => {
      result.current.show();
      result.current.minimize();
    });
    expect(result.current.minimized).toBe(true);
    act(() => result.current.restore());
    expect(result.current.minimized).toBe(false);
  });

  it("treats a capsule press that never travels as a click that restores", () => {
    const { result } = renderHook(() => useBtwWindow({ sideOpen: false, sideHeadRect: () => undefined }));
    const grip = surface("btw-capsule");
    act(() => {
      result.current.show();
      result.current.minimize();
    });
    act(() => result.current.beginMove(pointer(grip, 40, 40), "capsule"));
    act(() => fire(grip, "pointerup", 40, 40));
    expect(result.current.minimized).toBe(false);
    expect(result.current.placement).toBe("float");
  });

  it("commits a window drag that exceeds the click threshold", () => {
    const { result } = renderHook(() => useBtwWindow({ sideOpen: true, sideHeadRect: () => undefined }));
    const grip = surface("btw-window");
    const start = { ...result.current.rect };
    act(() => result.current.beginMove(pointer(grip, 100, 80), "window"));
    act(() => fire(grip, "pointermove", 100 + BTW_DRAG_THRESHOLD, 80));
    act(() => fire(grip, "pointerup", 100 + BTW_DRAG_THRESHOLD, 80));
    expect(result.current.rect.x).toBe(start.x + BTW_DRAG_THRESHOLD);
    expect(result.current.placement).toBe("float");
  });

  it("docks when a drag ends on the collapsed right-edge band", () => {
    const docks: number[] = [];
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const { result } = renderHook(() =>
      useBtwWindow({
        sideOpen: false,
        sideHeadRect: () => undefined,
        onDock: () => {
          docks.push(1);
        },
      }),
    );
    const grip = surface("btw-window");
    const startRect = result.current.rect;
    act(() => result.current.beginMove(pointer(grip, 200, 80), "window"));
    act(() => fire(grip, "pointermove", 1260, 80));
    act(() => fire(grip, "pointerup", 1260, 80));
    expect(result.current.placement).toBe("docked");
    expect(result.current.rect).toEqual(startRect);
    expect(docks).toEqual([1]);
  });

  it("undocks from the tab strip once the pointer leaves it, and treats a tap as a click", () => {
    const clicks: number[] = [];
    const { result } = renderHook(() =>
      useBtwWindow({
        sideOpen: true,
        sideHeadRect: () => ({ x: 800, y: 40, width: 480, height: 40 }),
      }),
    );
    const tab = surface("btw-tab");
    act(() => {
      result.current.show();
      result.current.dock();
    });
    act(() => result.current.beginUndockDrag(pointer(tab, 820, 50), () => clicks.push(1)));
    act(() => fire(tab, "pointerup", 820, 50));
    expect(clicks).toEqual([1]);
    expect(result.current.placement).toBe("docked");

    act(() => result.current.beginUndockDrag(pointer(tab, 820, 50), () => clicks.push(2)));
    act(() => fire(tab, "pointermove", 200, 200));
    act(() => fire(tab, "pointerup", 200, 200));
    expect(result.current.placement).toBe("float");
    expect(clicks).toEqual([1]);
  });

  it("ignores a non-primary button and clears the drag class on unmount", () => {
    const { result, unmount } = renderHook(() => useBtwWindow({ sideOpen: false, sideHeadRect: () => undefined }));
    const grip = surface("btw-window");
    act(() => result.current.beginMove({ ...pointer(grip, 100, 80), button: 2 }, "window"));
    expect(document.body.classList.contains("is-btw-dragging")).toBe(false);

    act(() => result.current.beginMove(pointer(grip, 100, 80), "window"));
    expect(document.body.classList.contains("is-btw-dragging")).toBe(true);
    unmount();
    expect(document.body.classList.contains("is-btw-dragging")).toBe(false);
  });

  it("restores whether the window was open", () => {
    const { result } = renderHook(() => useBtwWindow({ sideOpen: false, sideHeadRect: () => undefined }));
    act(() => result.current.restoreMemory({ open: true, placement: "docked" }));
    expect(result.current.open).toBe(true);
    expect(result.current.placement).toBe("docked");
  });
});
