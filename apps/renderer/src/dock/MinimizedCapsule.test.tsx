import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MinimizedCapsule } from "./MinimizedCapsule";

let frames = new Map<number, FrameRequestCallback>(), nextFrame = 0;
const flush = () => act(() => { const pending = frames; frames = new Map(); pending.forEach(callback => callback(0)); });
const hostFor = (button: HTMLElement) => button.parentElement!;
const pointOf = (button: HTMLElement) => ({ x: Number.parseFloat(hostFor(button).style.left), y: Number.parseFloat(hostFor(button).style.top) });
function move(button: HTMLElement, x: number, y: number, drop = true) {
  const box = button.getBoundingClientRect();
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: box.x + 8, clientY: box.y + 8 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: x + 8, clientY: y + 8 });
  flush();
  if (drop) {
    fireEvent.pointerUp(window, { pointerId: 1, clientX: x + 8, clientY: y + 8 });
    fireEvent.click(button); // Browsers also dispatch click after pointerup; jsdom needs it explicitly.
  }
}

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 768);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains("app-titlebar")) return new DOMRect(0, 0, 1024, 36);
    const host = this.closest<HTMLElement>(".dock-capsule-host");
    return new DOMRect(Number.parseFloat(host?.style.left ?? "") || 700, Number.parseFloat(host?.style.top ?? "") || 680, 160, 32);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); frames.clear(); });

describe("minimized capsule dragging", () => {
  it("moves one capsule out of its clipped group without restoring, and remembers its location when minimized again", () => {
    const owner = {}, restore = vi.fn();
    const view = render(<div style={{ overflow: "hidden", transform: "translateX(10px)" }}>
      <MinimizedCapsule owner={owner} capsuleId="first" onClick={restore}>First window</MinimizedCapsule>
      <MinimizedCapsule owner={owner} capsuleId="second">Second window</MinimizedCapsule>
    </div>);
    const first = screen.getByRole("button", { name: "First window" }), second = screen.getByRole("button", { name: "Second window" });
    move(first, 240, 170);
    expect(restore).not.toHaveBeenCalled();
    expect(pointOf(first)).toEqual({ x: 240, y: 170 });
    expect(hostFor(first).parentElement).toBe(document.body);
    expect(view.container.contains(second)).toBe(true);
    expect(screen.getByRole("button", { name: "First window" })).toBe(first);
    fireEvent.click(first);
    expect(restore).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.querySelector(".dock-capsule-host")).toBeNull();
    render(<MinimizedCapsule owner={owner} capsuleId="first" onClick={restore}>First window</MinimizedCapsule>);
    expect(pointOf(screen.getByRole("button", { name: "First window" }))).toEqual({ x: 240, y: 170 });
  });

  it("keeps small pointer movement as a click and cancels a drag back to the previous location", () => {
    const restore = vi.fn();
    const view = render(<MinimizedCapsule owner={{}} capsuleId="window" onClick={restore}>Window</MinimizedCapsule>);
    const button = screen.getByRole("button", { name: "Window" });
    move(button, 703, 682);
    expect(restore).toHaveBeenCalledOnce();
    move(button, 200, 120, false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.container.contains(button)).toBe(true);
    expect(hostFor(button).style.left).toBe("");
    move(button, 280, 220);
    move(button, 450, 300, false);
    fireEvent.blur(window);
    expect(pointOf(button)).toEqual({ x: 280, y: 220 });
    move(button, 500, 400, false);
    view.unmount();
    expect(document.body.classList.contains("dock-dragging")).toBe(false);
    expect(document.querySelector(".dock-capsule-host")).toBeNull();
  });

  it("stays reachable on resize, isolates workspace positions and honors layout lock", () => {
    const owner = {}, restore = vi.fn();
    const view = render(<><header className="app-titlebar" /><MinimizedCapsule owner={owner} capsuleId="window" onClick={restore}>Window</MinimizedCapsule></>);
    const button = screen.getByRole("button", { name: "Window" });
    move(button, 1800, 1200);
    expect(pointOf(button)).toEqual({ x: 856, y: 728 });
    vi.stubGlobal("innerWidth", 640); vi.stubGlobal("innerHeight", 480);
    fireEvent.resize(window);
    expect(pointOf(button)).toEqual({ x: 472, y: 440 });
    move(button, -200, -100);
    expect(pointOf(button)).toEqual({ x: 8, y: 44 }); // Stay below the native titlebar hit area.
    view.rerender(<><header className="app-titlebar" /><MinimizedCapsule owner={{}} capsuleId="window" locked onClick={restore}>Window</MinimizedCapsule></>);
    expect(view.container.contains(button)).toBe(true);
    move(button, 300, 200);
    expect(view.container.contains(button)).toBe(true);
    expect(restore).toHaveBeenCalledOnce();
  });
});
