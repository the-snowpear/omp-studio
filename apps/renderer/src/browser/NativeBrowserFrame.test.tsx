import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeBrowserFrame, browserFramePoint } from "./NativeBrowserFrame";
import { NativeBrowserFrames, type NativeBrowserFrame as Frame, type NativeBrowserState } from "./useNativeBrowserObservation";
const copy = (zh: string) => zh;
const state: NativeBrowserState = { kind: "state", observationId: "o", tabId: "tab", generation: "generation", documentEpoch: 0, title: "Same tab", url: "https://example.test", frozen: false, busy: false, control: "human", leaseId: "lease" };
const frame = (sequence: number): Frame => ({ kind: "frame", observationId: "o", tabId: "tab", generation: "generation", documentEpoch: 0, sequence, data: btoa(`frame-${sequence}`), width: 1600, height: 800, cssWidth: 800, cssHeight: 400, timestamp: sequence });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("maps capture pixels through letterboxing without mistaking margins for CSS coordinates", () => {
  expect(browserFramePoint({ left: 10, top: 20, width: 400, height: 400 }, { width: 1600, height: 800 }, 210, 220)).toEqual({ x: 0.5, y: 0.5 });
  expect(browserFramePoint({ left: 10, top: 20, width: 400, height: 400 }, { width: 1600, height: 800 }, 210, 30)).toBeUndefined();
});

it("keeps IME composition mounted across frame replacement and sends its committed text only once", () => {
  const frames = new NativeBrowserFrames(), input = vi.fn(async () => {}), acknowledge = vi.fn(async () => {});
  let parentRenders = 0;
  function Pane() { parentRenders++; return <NativeBrowserFrame frames={frames} state={state} preview={false} connecting={false} paused={false} error="" copy={copy} resume={() => {}} acknowledge={acknowledge} input={input} onDecodeError={() => {}} onAddress={() => {}} />; }
  render(<Pane />);
  act(() => frames.publish(frame(1)));
  const textbox = screen.getByRole("textbox", { name: /向原生页面输入/ });
  fireEvent.compositionStart(textbox);
  fireEvent.change(textbox, { target: { value: "中文" } });
  fireEvent.keyDown(textbox, { key: "Process", code: "KeyA", isComposing: true });
  expect(input).not.toHaveBeenCalled();
  act(() => frames.publish(frame(2)));
  expect(screen.getByRole("textbox", { name: /向原生页面输入/ })).toBe(textbox);
  expect((textbox as HTMLTextAreaElement).value).toBe("中文");
  fireEvent.compositionEnd(textbox, { data: "中文" });
  expect(input).toHaveBeenCalledTimes(1);
  expect(input).toHaveBeenCalledWith({ kind: "text", sequence: 2, text: "中文" });
  expect((textbox as HTMLTextAreaElement).value).toBe("");
  expect(parentRenders).toBe(1);
});

it("does not acknowledge a late load from the replaced image", () => {
  const frames = new NativeBrowserFrames(), acknowledge = vi.fn(async () => {});
  const first = frame(1), second = frame(2);
  render(<NativeBrowserFrame frames={frames} state={state} preview={false} connecting={false} paused={false} error="" copy={copy} resume={() => {}} acknowledge={acknowledge} input={async () => {}} onDecodeError={() => {}} onAddress={() => {}} />);
  act(() => frames.publish(first));
  const image = screen.getByAltText("当前原生浏览器画面");
  Object.defineProperty(image, "currentSrc", { configurable: true, value: `data:image/jpeg;base64,${first.data}` });
  act(() => frames.publish(second));
  fireEvent.load(image);
  expect(acknowledge).not.toHaveBeenCalled();
  Object.defineProperty(image, "currentSrc", { configurable: true, value: `data:image/jpeg;base64,${second.data}` });
  fireEvent.load(image);
  expect(acknowledge).toHaveBeenCalledWith(second);
});
