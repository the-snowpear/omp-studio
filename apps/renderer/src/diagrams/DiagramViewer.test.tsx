import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewSurface } from "../preview/PreviewContext";
import { DiagramViewer } from "./DiagramViewer";
import { mermaidQueue } from "../conversation/LazyMermaid";

const code = "flowchart LR\n A[Input] --> B[Result]";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1000" style="max-width:2000px" width="100%"><text x="100" y="100">Readable labels</text></svg>';
let width = 600, height = 300;
const revoked = vi.fn();
beforeEach(() => {
  width = 600; height = 300;
  const NativeUrl = URL;
  vi.stubGlobal("URL", class extends NativeUrl { static createObjectURL = () => "blob:diagram"; static revokeObjectURL = revoked; });
  vi.stubGlobal("ResizeObserver", class { constructor(read: () => void) { this.read = read; } read: () => void; observe() { this.read(); } disconnect() {} });
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("diagram-viewport") ? width : 0; });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("diagram-viewport") ? height : 0; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); revoked.mockClear(); });
const view = (language: "zh" | "en", preview = false, source = code, initial: string | null = svg) => <PreviewSurface preview={preview}>
  <I18nProvider forcedLanguage={language}><DiagramViewer code={source} initialSvg={initial ?? undefined} visible /></I18nProvider>
</PreviewSurface>;

it("zooms a vector diagram, pans it, and retains both through live language switches", async () => {
  const mounted = render(view("en"));
  const viewport = await screen.findByRole("region", { name: "Diagram viewport" });
  const image = screen.getByRole("img", { name: "Mermaid diagram" });
  expect(image.style.width).toBe("2000px");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("125%");
  expect(image.style.width).toBe("2500px");
  fireEvent.pointerDown(viewport, { button: 0, clientX: 300, clientY: 150 });
  fireEvent.pointerMove(viewport, { clientX: 240, clientY: 120 });
  fireEvent.pointerUp(viewport);
  const position = { x: viewport.scrollLeft, y: viewport.scrollTop };
  expect(position.x).toBeGreaterThan(0);
  mounted.rerender(view("zh"));
  expect(screen.getByRole("status", { name: "缩放比例" }).textContent).toBe("125%");
  expect(screen.getByRole("button", { name: "放大" })).toBeDefined();
  expect(viewport.scrollLeft).toBe(position.x);
  expect(viewport.scrollTop).toBe(position.y);
  mounted.rerender(view("en"));
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("125%");
  expect(viewport.scrollLeft).toBe(position.x);
  expect(revoked).not.toHaveBeenCalled();
});

it("contains wheel zoom, supports keyboard fit, and returns from source without losing zoom", async () => {
  render(view("en"));
  const viewport = await screen.findByRole("region", { name: "Diagram viewport" });
  const wheel = new WheelEvent("wheel", { deltaY: -100, clientX: 300, clientY: 150, cancelable: true, bubbles: true });
  fireEvent(viewport, wheel);
  expect(wheel.defaultPrevented).toBe(true);
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("125%");
  fireEvent.click(screen.getByRole("button", { name: "View source" }));
  expect(screen.getByText((_text, element) => element?.tagName === "CODE" && element.textContent === code)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Back to diagram" }));
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("125%");
  fireEvent.keyDown(screen.getByRole("region", { name: "Diagram viewport" }), { key: "0" });
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("30%");
  fireEvent.keyDown(screen.getByRole("region", { name: "Diagram viewport" }), { key: "1" });
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("100%");
});

it("preserves source and translates the render failure on the mounted viewer", async () => {
  vi.spyOn(mermaidQueue, "request").mockImplementation((_code, subscriber) => {
    queueMicrotask(() => subscriber.result(null));
    return { status: "accepted", cancel: () => {} };
  });
  const mounted = render(view("zh", false, "flowchart LR\n broken", null));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("已保留源码"));
  expect(screen.getByText((_text, element) => element?.tagName === "CODE" && element.textContent === "flowchart LR\n broken")).toBeDefined();
  mounted.rerender(view("en", false, "flowchart LR\n broken", null));
  expect(screen.getByRole("alert").textContent).toContain("source retained");
});

it("retains panning through source view after selecting the already active zoom", async () => {
  render(view("en"));
  const viewport = await screen.findByRole("region", { name: "Diagram viewport" });
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  fireEvent.pointerDown(viewport, { button: 0, clientX: 300, clientY: 150 });
  fireEvent.pointerMove(viewport, { clientX: 100, clientY: 50 });
  fireEvent.pointerUp(viewport);
  fireEvent.click(screen.getByRole("button", { name: "View source" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to diagram" }));
  const restored = screen.getByRole("region", { name: "Diagram viewport" });
  expect(restored.scrollLeft).toBe(200);
  expect(restored.scrollTop).toBe(100);
});

it("releases the vector image URL when the viewer closes", async () => {
  const mounted = render(view("en"));
  await screen.findByRole("region", { name: "Diagram viewport" });
  act(() => mounted.unmount());
  expect(revoked).toHaveBeenCalledWith("blob:diagram");
});
