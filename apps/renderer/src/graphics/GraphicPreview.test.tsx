import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GraphicResult } from "./graphic-types";
import { GraphicPreview } from "./GraphicPreview";
import { MarkdownText } from "../conversation/markdown";

vi.mock("./GraphicScene", async () => {
  const { useEffect } = await import("react");
  return { default: ({ onPoster }: { onPoster: (blob: Blob) => void }) => {
    useEffect(() => onPoster(new Blob(["frame"], { type: "image/webp" })), [onPoster]);
    return <div aria-label="3D viewer">Rendered model</div>;
  } };
});
vi.mock("./SvgFigureImage", () => ({ SvgFigureImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));

class Observer {
  static all: Observer[] = [];
  target?: Element;
  disconnected = false;
  constructor(readonly callback: IntersectionObserverCallback) { Observer.all.push(this); }
  observe(target: Element) { this.target = target; }
  disconnect() { this.disconnected = true; }
  show(visible: boolean) {
    if (!this.disconnected) this.callback([{ isIntersecting: visible, target: this.target! } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
class ParserWorker {
  static all: ParserWorker[] = [];
  onmessage?: (event: MessageEvent) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { ParserWorker.all.push(this); }
  finish(data: object) { this.onmessage?.({ data } as MessageEvent); }
}
const scene = (): GraphicResult => ({ kind: "scene", meshes: [], images: [], warnings: [] });
const settle = (ms = 160) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  Observer.all = []; ParserWorker.all = [];
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("Worker", ParserWorker);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:poster");
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows the last frame offscreen and reuses the parsed model on return", async () => {
  render(<GraphicPreview name="scroll-return.obj" text="v 0 0 0" />);
  act(() => Observer.all[0]!.show(true));
  await settle();
  act(() => ParserWorker.all[0]!.finish({ ok: true, result: scene() }));
  await settle();
  expect(screen.getByLabelText("3D viewer")).toBeTruthy();

  act(() => Observer.all[0]!.show(false));
  await settle();
  expect(screen.queryByLabelText("3D viewer")).toBeNull();
  expect(screen.getByAltText("scroll-return.obj").getAttribute("src")).toBe("blob:poster");

  act(() => Observer.all[0]!.show(true));
  await settle();
  expect(screen.getByLabelText("3D viewer")).toBeTruthy();
  expect(ParserWorker.all).toHaveLength(1);
});

it("waits for the conversation scroll to settle before mounting a completed 3D result", async () => {
  const view = render(<div data-testid="scroller"><GraphicPreview name="scroll-busy.obj" text="v 1 0 0" /></div>);
  act(() => Observer.all[0]!.show(true));
  await settle();
  act(() => ParserWorker.all[0]!.finish({ ok: true, result: scene() }));
  for (let index = 0; index < 3; index++) {
    await settle(80);
    fireEvent.scroll(view.getByTestId("scroller"));
    expect(screen.queryByLabelText("3D viewer")).toBeNull();
  }
  await settle();
  expect(screen.getByLabelText("3D viewer")).toBeTruthy();
});

it("keeps a generated numeric chart across scrolling and hide/show", async () => {
  render(<MarkdownText text={"| Model | Latency |\n| --- | ---: |\n| A | 10 ms |\n| B | 20 ms |"} />);
  act(() => Observer.all[0]!.show(true));
  await settle();
  act(() => ParserWorker.all[0]!.finish({ ok: true, figure: { svg: "<svg/>", alt: "Latency" } }));
  await settle();
  expect(screen.getByAltText("Latency")).toBeTruthy();
  act(() => Observer.all[0]!.show(false));
  await settle();
  expect(screen.getByAltText("Latency")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起图表" }));
  fireEvent.click(screen.getByRole("button", { name: "显示图表" }));
  expect(screen.getByAltText("Latency")).toBeTruthy();
  expect(ParserWorker.all).toHaveLength(1);
});
