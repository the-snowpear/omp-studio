import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerFrameView } from "./ComputerFrameView";
import { previewComputerFrame } from "../preview/computerPreview";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("releases temporary observation pixels at expiry without capturing a replacement", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ ok: true, data: new ArrayBuffer(8), width: 1280, height: 800, mimeType: "image/png" }));
  vi.stubGlobal("ompStudioChrome", { readComputerFrame: read });
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:temporary-frame") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  await act(async () => {
    render(<ComputerFrameView frame={{ ...previewComputerFrame("child"), source: "observation", expiresAt: Date.now() + 5000 }} scopeSessionId="root" scopeKey="epoch" executionTarget={{ kind: "local" }} visible viewportHeight={400} preview={false} zh empty={["", ""]} />);
  });
  expect(screen.getByAltText("电脑目标截图")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(screen.queryByAltText("电脑目标截图")).toBeNull();
  expect(screen.getByText("观察画面已过期，请显式刷新获取新画面。")).toBeTruthy();
  expect(revoke).toHaveBeenCalledWith("blob:temporary-frame");
  expect(read).toHaveBeenCalledTimes(1);
});
