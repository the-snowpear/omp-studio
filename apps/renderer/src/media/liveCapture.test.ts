import { afterEach, expect, it, vi } from "vitest";
import { openLiveCapture } from "./liveCapture";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("late microphone consent after cancellation releases tracks without attaching or connecting", async () => {
  let grant!: (value: unknown) => void; const stop = vi.fn(), attach = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  vi.stubGlobal("ompStudioChrome", { attachLiveAudio: vi.fn(), appendLiveAudio: vi.fn(), detachLiveAudio: vi.fn() });
  const controller = new AbortController();
  const pending = openLiveCapture({ signal: controller.signal, attach, onFault: vi.fn() });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" }); controller.abort(); grant({ getTracks: () => [{ stop }] }); await rejected;
  expect(stop).toHaveBeenCalledOnce(); expect(attach).not.toHaveBeenCalled();
});
