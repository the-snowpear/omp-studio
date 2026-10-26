import { selectOption } from "../test/selectOption";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, CommandState, StudioClient } from "@omp-studio/client-contract";
import type { StudioComputerStatus } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { ComputerPane } from "./ComputerPane";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const capabilities: ClientBootstrap["capabilityManifest"] = {
  profile: "limited",
  generatedAt: "2026-10-25T00:00:00.000Z",
  hash: "computer-test",
  capabilities: ["computer.status", "computer.configure", "computer.capture", "computer.stop", "computer.observe.release"].map(id => ({
    id, grade: "stable" as const, version: 1, evidence: "Computer Use test",
  })),
};

function receiptClient(resultFor: (kind: string, input: unknown) => unknown) {
  const commands: Record<string, CommandState> = {};
  let sequence = 0;
  const command = vi.fn(async (kind: string, input: unknown) => {
    const requestId = `computer-${++sequence}`;
    commands[requestId] = {
      requestId,
      commandName: kind,
      status: "completed",
      observedAt: "2026-10-25T00:00:00.000Z",
      result: { result: resultFor(kind, input) },
    } as CommandState;
    return { requestId };
  });
  const client = { command, getState: () => ({ commands }) } as unknown as StudioClient;
  return { client, command };
}

function pane(client: StudioClient, { visible = true, sessionId, native = false }: { visible?: boolean; sessionId?: string; native?: boolean } = {}) {
  return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled>
    <ComputerPane client={client} available visible={visible} sessionId={sessionId} capabilities={native ? capabilities : undefined} />
  </PreviewModeProvider></I18nProvider>;
}

it("previews capture and stop locally and drops the picture when hidden", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  const { rerender } = render(pane(client));

  fireEvent.click(screen.getByRole("button", { name: "刷新截图" }));
  await waitFor(() => expect(screen.getByAltText("所选电脑目标截图")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
  expect(screen.getByAltText("电脑截图大图")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "停止电脑操作" }));
  expect(screen.getByText("演示：已请求停止")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
  rerender(pane(client, { visible: false }));
  expect(screen.queryByAltText("所选电脑目标截图")).toBeNull();
  expect(screen.queryByAltText("电脑截图大图")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});

it("enables native Computer Use after confirmation and immediately reads the real targets", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  let enabled = false;
  const nativeStatus = (): StudioComputerStatus => ({
    enabled, available: enabled, backend: enabled ? "win32" : "unavailable",
    capturePermission: enabled ? "granted" : "unknown",
    inputPermission: enabled ? "granted" : "unknown",
    axPermission: enabled ? "granted" : "unknown",
    running: 0,
    targets: enabled ? [{ id: "native-display", kind: "display", name: "Main display", width: 1920, height: 1080 }] : [],
    ...(!enabled ? { reason: "Computer Use is disabled in native settings." } : {}),
  });
  const { client, command } = receiptClient((kind, input) => {
    if (kind === "computer.status") return nativeStatus();
    if (kind === "computer.configure") {
      enabled = (input as { enabled: boolean }).enabled;
      return { enabled };
    }
    return { released: true };
  });
  render(pane(client, { sessionId: "session-1", native: true }));

  fireEvent.click(await screen.findByRole("button", { name: "启用 Computer Use" }));
  expect(screen.queryByText(/unknown/)).toBeNull();
  expect(command.mock.calls.some(([kind]) => kind === "computer.configure")).toBe(false);

  const dialog = screen.getByRole("dialog", { name: "启用 Computer Use" });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认启用" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("computer.configure", { sessionId: "session-1", enabled: true }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "屏幕或窗口" }).textContent).toBe("Main display · 1920 × 1080"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(command.mock.calls.filter(([kind]) => kind === "computer.status")).toHaveLength(2);
});

it("clears the old screenshot when the selected target or conversation changes", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient;
  const { rerender } = render(pane(client, { sessionId: "session-1" }));

  fireEvent.click(screen.getByRole("button", { name: "刷新截图" }));
  await screen.findByAltText("所选电脑目标截图");
  selectOption(screen.getByRole("combobox", { name: "屏幕或窗口" }), "OMP Studio · Workspace");
  expect(screen.queryByAltText("所选电脑目标截图")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "刷新截图" }));
  await screen.findByAltText("所选电脑目标截图");
  rerender(pane(client, { sessionId: "session-2" }));
  expect(screen.queryByAltText("所选电脑目标截图")).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
});

it("does not issue Computer Use commands to a Runtime without that capability", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const client = { command: vi.fn() } as unknown as StudioClient;
  const { unmount } = render(pane(client, { sessionId: "older-runtime" }));
  expect(client.command).not.toHaveBeenCalled();
  unmount();
  expect(client.command).not.toHaveBeenCalled();
});

it("shows native target enumeration errors instead of an ordinary empty target state", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  vi.stubGlobal("ompStudioChrome", { readComputerCapture: vi.fn() });
  const reason = "Failed to enumerate native windows: desktop session is unavailable.";
  const nativeStatus: StudioComputerStatus = {
    enabled: true, available: true, backend: "win32",
    capturePermission: "granted", inputPermission: "granted", axPermission: "granted",
    running: 0, targets: [], reason,
  };
  const { client } = receiptClient(kind => kind === "computer.status" ? nativeStatus : { released: true });
  render(pane(client, { sessionId: "session-1", native: true }));

  expect(await screen.findByRole("heading", { name: "无法读取观察目标" })).toBeTruthy();
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.queryByText("暂无可观察的目标")).toBeNull();
});
