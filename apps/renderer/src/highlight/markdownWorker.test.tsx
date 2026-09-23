import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownText } from "../conversation/markdown";
import type { HighlightResult } from "./pool";

const mock = vi.hoisted(() => ({ request: vi.fn(), onSlot: vi.fn() }));
vi.mock("../performanceOptions", () => ({ performanceOptions: { highlightWorker: true, boundedMermaid: false } }));
vi.mock("./service", () => ({ highlightPool: mock }));
let complete: (result: HighlightResult) => void;
beforeEach(() => {
  mock.onSlot.mockReturnValue(() => {});
  mock.request.mockImplementation((_language, _code, subscriber) => { complete = subscriber.result; return { status: "accepted", cancel: vi.fn() }; });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows an open streaming fence immediately and does not start highlight computation", () => {
  const { container } = render(<MarkdownText text={'```ts\nconst a ='} streaming />);
  expect(container.querySelector(".md-code")).not.toBeNull();
  expect(container.querySelector(".md-code-lang")?.textContent).toBe("ts");
  expect(container.querySelector("pre code")?.textContent).toBe("const a =");
  expect(mock.request).not.toHaveBeenCalled();
});
it("keeps the frame, exact copy text and scroll position as colors arrive", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { container } = render(<MarkdownText text={'```ts\nconst a = 1;\n```'} />);
  const frame = container.querySelector(".md-code");
  const pre = container.querySelector("pre")!;
  expect(pre.textContent).toBe("const a = 1;\n");
  pre.scrollTop = 37;
  act(() => complete({ ok: true, tokens: [{ type: "span", classes: ["hljs-keyword"], children: [{ type: "text", value: "const" }] }, { type: "text", value: " a = 1;\n" }] }));
  expect(container.querySelector(".md-code")).toBe(frame);
  expect(pre.scrollTop).toBe(37);
  expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
  fireEvent.click(container.querySelector(".md-code-copy")!);
  await act(async () => {});
  expect(writeText).toHaveBeenCalledWith("const a = 1;");
});
it("ignores stale results after source changes and retries a full queue on a slot signal", () => {
  let slot!: () => void;
  mock.onSlot.mockImplementation((callback) => { slot = callback; return () => {}; });
  mock.request.mockReturnValueOnce({ status: "full", cancel: () => {} });
  const view = render(<MarkdownText text={'```ts\nfirst\n```'} />);
  act(() => slot());
  const stale = complete;
  expect(mock.request).toHaveBeenCalledTimes(2);
  view.rerender(<MarkdownText text={'```ts\nsecond\n```'} />);
  act(() => stale({ ok: true, tokens: [{ type: "text", value: "first\n" }] }));
  expect(view.container.querySelector("pre")?.textContent).toBe("second\n");
});
it("preserves the enclosing Markdown block eligibility and renders timeout results as plain text", () => {
  const view = render(<MarkdownText text={'```ts\nplain\n```'} />);
  act(() => complete({ ok: false, reason: "timeout" }));
  expect(view.container.querySelector("pre")?.textContent).toBe("plain\n");
  mock.request.mockClear();
  view.rerender(<MarkdownText text={'x'.repeat(96 * 1024) + '\n\n```ts\nplain\n```'} />);
  expect(mock.request).not.toHaveBeenCalled();
});
