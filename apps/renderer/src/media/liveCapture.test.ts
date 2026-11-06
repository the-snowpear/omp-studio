import { afterEach, expect, it, vi } from "vitest";
import { openLiveCapture, openPcmCapture } from "./liveCapture";

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
it("stops microphone tracks immediately and waits for the partial frame and pending append before closing", async () => {
  const order: string[] = [];
  const track = { onended: null, stop: vi.fn(() => order.push("tracks-stopped")) };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  let message: ((event: { data: unknown }) => void) | null = null;
  let releaseFrame!: () => void;
  const frameWrite = new Promise<void>(resolve => { releaseFrame = resolve; });
  const port = {
    get onmessage() { return message; }, set onmessage(listener: typeof message) { message = listener; },
    postMessage: (value: string) => {
      if (value === "drain") {
        order.push("drain-request");
        message?.({ data: { bytes: new Float32Array([.25, .5]).buffer } });
        message?.({ data: { drained: true } });
      }
    }, close: vi.fn(() => order.push("port-closed")),
  };
  class Context {
    sampleRate = 16000; destination = {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    resume = async () => {};
    close = async () => { order.push("context-closed"); };
  }
  class Processor { port = port; onprocessorerror = null; connect() {} disconnect() {} }
  vi.stubGlobal("AudioContext", Context); vi.stubGlobal("AudioWorkletNode", Processor);
  const onFrame = vi.fn(async (bytes: ArrayBuffer, sequence: number) => { order.push("append-start"); expect([...new Float32Array(bytes)]).toEqual([.25, .5]); expect(sequence).toBe(0); await frameWrite; order.push("append-done"); });
  const capture = await openPcmCapture({ signal: new AbortController().signal, onFrame, onFault: vi.fn() });
  const finished = capture.finish();
  expect(track.stop).toHaveBeenCalledOnce(); expect(port.close).not.toHaveBeenCalled();
  await Promise.resolve(); expect(onFrame).toHaveBeenCalledOnce();
  releaseFrame(); await finished;
  expect(order.indexOf("tracks-stopped")).toBeLessThan(order.indexOf("append-start"));
  expect(order.indexOf("append-done")).toBeLessThan(order.indexOf("port-closed"));
  await capture.finish(); expect(onFrame).toHaveBeenCalledOnce();
});
