import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { AudioCapturePane } from "./AudioCapturePane";
vi.mock("./audio", () => ({ normalizeAudio: vi.fn(async (blob: Blob) => blob), uploadMediaBlob: vi.fn(async () => ({ artifactId: "saved" })) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
function page(sessionId: string) { return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled={false}><AudioCapturePane sessionId={sessionId} onSaved={() => {}} /></PreviewModeProvider></I18nProvider>; }
function devices(getUserMedia: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("ompStudioChrome", { beginMediaUpload: vi.fn() });
  class Recorder { static isTypeSupported() { return true; } state = "inactive"; mimeType = "audio/webm"; onstop?: () => void; start() { this.state = "recording"; } stop() { this.state = "inactive"; this.onstop?.(); } }
  vi.stubGlobal("MediaRecorder", Recorder);
}
it("releases a late permission grant after the capture surface is removed", async () => {
  let grant!: (stream: unknown) => void; const stop = vi.fn();
  devices(() => new Promise(resolve => { grant = resolve; }));
  const view = render(page("one")); fireEvent.click(screen.getByRole("button", { name: "开始录音" })); view.unmount();
  await act(async () => { grant({ getTracks: () => [{ stop }] }); }); expect(stop).toHaveBeenCalledOnce();
});
it("stops every microphone track when changing sessions or hiding the window", async () => {
  const stop = vi.fn(); devices(async () => ({ getTracks: () => [{ stop }] }));
  const view = render(page("one")); fireEvent.click(screen.getByRole("button", { name: "开始录音" }));
  await screen.findByRole("button", { name: "停止录音并保存" }); view.rerender(page("two")); expect(stop).toHaveBeenCalled(); stop.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "开始录音" })); await screen.findByRole("button", { name: "停止录音并保存" });
  vi.spyOn(document, "hidden", "get").mockReturnValue(true); await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); expect(stop).toHaveBeenCalled();
});
