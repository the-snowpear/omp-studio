import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { I18nProvider } from "../i18n";
import { TokenUsagePanel } from "./TokenUsagePanel";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); localStorage.clear(); });
const telemetry: SessionTelemetrySnapshot = {
  sessionId: "session" as SessionTelemetrySnapshot["sessionId"], capturedAt: "2026-11-02T06:00:00Z", context: null,
  tokens: { input: 1000, output: 200, reasoning: 50, cacheRead: 3000, cacheWrite: 400, total: 4600, cost: 0.12 },
  servedModel: "provider/served-model", requestedModel: "provider/requested-model",
};
function mount(snapshot: SessionTelemetrySnapshot | null = null) {
  const onClose = vi.fn(), onOpenCounter = vi.fn();
  render(<PreviewModeProvider><I18nProvider forcedLanguage="zh"><TokenUsagePanel telemetry={snapshot} view={undefined} onClose={onClose} onOpenCounter={onOpenCounter} /></I18nProvider></PreviewModeProvider>);
  return { onClose, onOpenCounter };
}
it("launches the separate counter without embedding tools or context actions in usage", () => {
  window.history.replaceState(null, "", "/?preview=1&marks=off");
  const { onOpenCounter, onClose } = mount();
  expect(screen.getByText("220.4k")).toBeTruthy();
  expect(screen.queryByText(/演示/)).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "打开上下文查看器" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "离线 Token 计数" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭用量详情" }));
  expect(onOpenCounter).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
it("shows real usage and preserves model details", () => {
  mount(telemetry);
  expect(screen.getByText("4.6k")).toBeTruthy();
  expect(screen.getByText("75%")).toBeTruthy();
  expect(screen.queryByText("220.4k")).toBeNull();
  fireEvent.click(screen.getByText("更多用量明细"));
  expect(screen.getByText("provider/served-model")).toBeTruthy();
  expect(screen.getByText("provider/requested-model")).toBeTruthy();
});
it("shows an honest empty state and keeps the separate counter available", () => {
  const { onOpenCounter } = mount();
  expect(screen.getByText("暂无用量记录")).toBeTruthy();
  expect(screen.queryByText("220.4k")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "离线 Token 计数" }));
  expect(onOpenCounter).toHaveBeenCalledOnce();
});
