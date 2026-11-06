import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ComputerLinkProvider } from "../computer/links";
import { ToolBody } from "./ToolBody";
import type { ToolView } from "./conversationViewModel";
import { computerToolMedia } from "./toolMeta";
const image = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", mimeType: "image/png", computerFrame: { frameId: "frame-one", sessionId: "child", toolCallId: "eval-one" } };
function tool(name: string): ToolView { return { toolName: name, toolCallId: "eval-one", status: "succeeded", result: { type: "toolResult", toolName: name, toolCallId: "eval-one", isError: false, data: { media: [image, { computerFrame: image.computerFrame }], cells: [{ code: "await computer.screenshot()", stdout: "captured", media: [image] }] } } }; }
afterEach(cleanup);
for (const kind of ["computer", "eval"]) it(`${kind} renders one image per frame and opens the exact same frame`, () => {
  const open = vi.fn();
  render(<I18nProvider forcedLanguage="zh"><ComputerLinkProvider onOpen={open}><ToolBody tool={tool(kind)} /></ComputerLinkProvider></I18nProvider>);
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "在电脑中查看" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "在电脑中查看" }));
  expect(open).toHaveBeenCalledWith({ frameId: "frame-one", sessionId: "child", toolCallId: "eval-one" });
});
it("keeps ordinary Eval code and pretty output without a Computer entry", () => {
  render(<ToolBody tool={{ toolName: "eval", toolCallId: "plain", status: "succeeded", result: { type: "toolResult", toolName: "eval", toolCallId: "plain", isError: false, data: { cells: [{ code: "1 + 2", stdout: "3" }], media: [{ data: image.data, mimeType: image.mimeType }] } } }} />);
  expect(screen.getByText("1 + 2")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Computer|电脑/ })).toBeNull();
  expect(screen.getAllByRole("img")).toHaveLength(1);
});
it("projects a frame reference even when inline data is absent", () => {
  const value: ToolView = { toolName: "eval", toolCallId: "call", status: "succeeded", result: { type: "toolResult", toolName: "eval", toolCallId: "call", isError: false, data: { media: [{ computerFrame: { frameId: "opaque" } }] } } };
  expect(computerToolMedia(value)).toEqual([{ key: "frame:opaque", frame: { frameId: "opaque", toolCallId: "call" } }]);
});
