import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_DICTATION_CONFIGURATION } from "../preview/dictationPreview";
import { agentBtwPreview } from "../preview/agentBtwPreview";
import { AgentBtwPane } from "./AgentBtwPane";
import { BtwPanel } from "./BtwPanel";
import { useBtwSession } from "./useBtwSession";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

for (const preview of [false, true]) {
  for (const child of [false, true]) {
    it(`${preview ? "preview" : "live"} ${child ? "child" : "main"} BTW exposes voice controls using the connected session`, async () => {
      const receipts: Record<string, unknown> = {};
      let sequence = 0;
      const command = vi.fn(async (kind: string) => {
        const requestId = `voice-${++sequence}`;
        const result = kind === "dictation.inspect"
          ? { ...PREVIEW_DICTATION_CONFIGURATION, enabled: false }
          : kind === "agent.btw.read" ? agentBtwPreview("child") : { sessionId: "connected", topics: [] };
        receipts[requestId] = { requestId, status: "completed", result: { result } };
        return { requestId };
      });
      const client = { command, query: vi.fn(async () => ({ capabilities: [] })), getState: () => ({ commands: receipts }), subscribe: () => () => {} } as unknown as StudioClient;
      function Main() {
        const session = useBtwSession({ snapshot: null, client, sessionId: "connected", preview, canCommand: true });
        return <BtwPanel session={session} demo={preview} />;
      }
      localStorage.setItem("omp.previewMode", preview ? "1" : "0");
      render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled>{child
        ? <AgentBtwPane client={client} sessionId="connected" agentId="child" available />
        : <Main />}</PreviewModeProvider></I18nProvider>);
      expect(screen.getByRole("button", { name: "语音输入" })).toBeTruthy();
      await waitFor(() => expect(command).toHaveBeenCalledWith("dictation.inspect", { sessionId: "connected" }));
      expect(screen.queryByRole("button", { name: "语音输入选项" })).toBeNull();
      fireEvent.contextMenu(screen.getByRole("button", { name: "语音输入" }));
      expect(await screen.findByRole("button", { name: "启用语音输入" })).toBeTruthy();
      expect(screen.queryByText("旁路问答 · 不写入主对话")).toBeNull();
      expect(screen.queryByText("Enter 发送 · Shift + Enter 换行")).toBeNull();
      expect(command.mock.calls.some(([kind]) => kind === "dictation.open" || kind === "btw.ask" || kind === "agent.btw.ask")).toBe(false);
    });
  }
}

it("keeps the voice entry visible without a connected session and explains the unavailable channel", async () => {
  function Surface() {
    const session = useBtwSession({ snapshot: null, client: null, preview: true, canCommand: false });
    return <BtwPanel session={session} />;
  }
  render(<I18nProvider forcedLanguage="zh"><Surface /></I18nProvider>);
  const microphone = screen.getByRole("button", { name: "语音输入" });
  fireEvent.keyDown(microphone, { key: "F10", shiftKey: true });
  expect(await screen.findByRole("dialog", { name: "语音输入状态" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起听写面板" }));
  fireEvent.keyDown(microphone, { key: "ContextMenu" });
  expect(await screen.findByRole("dialog", { name: "语音输入状态" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起听写面板" }));
  fireEvent.click(microphone);
  expect(await screen.findByText("此窗口没有新版桌面听写通道。请使用更新后的桌面应用。")).toBeTruthy();
});

it("does not open a voice error panel just because background configuration inspection failed", async () => {
  const command = vi.fn(async () => { throw Error("Runtime does not support dictation"); });
  const client = { command, query: async () => ({ capabilities: [] }) } as unknown as StudioClient;
  function Surface() {
    const session = useBtwSession({ snapshot: null, client, sessionId: "connected", preview: true, canCommand: true });
    return <BtwPanel session={session} />;
  }
  render(<I18nProvider forcedLanguage="zh"><Surface /></I18nProvider>);
  await waitFor(() => expect(command).toHaveBeenCalledWith("dictation.inspect", { sessionId: "connected" }));
  expect(screen.queryByRole("dialog", { name: "语音输入状态" })).toBeNull();
  fireEvent.contextMenu(screen.getByRole("button", { name: "语音输入" }));
  expect(await screen.findByRole("dialog", { name: "语音输入状态" })).toBeTruthy();
});

it("keeps the voice panel open while choosing an input device from its popup", async () => {
  vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [
    { kind: "audioinput", deviceId: "usb-mic", label: "USB 麦克风" },
  ] } });
  function Surface() {
    const session = useBtwSession({ snapshot: null, client: null, preview: true, canCommand: false });
    return <BtwPanel session={session} />;
  }
  render(<I18nProvider forcedLanguage="zh"><Surface /></I18nProvider>);
  fireEvent.contextMenu(screen.getByRole("button", { name: "语音输入" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "听写麦克风" })).toBeTruthy());
  fireEvent.click(screen.getByRole("combobox", { name: "听写麦克风" }));
  const option = await screen.findByRole("option", { name: "USB 麦克风" });
  fireEvent.pointerDown(option);
  expect(screen.getByRole("dialog", { name: "语音输入状态" })).toBeTruthy();
  fireEvent.click(option);
  expect(screen.getByRole("combobox", { name: "听写麦克风" }).textContent).toContain("USB 麦克风");
  expect(screen.getByRole("dialog", { name: "语音输入状态" })).toBeTruthy();
  expect(screen.queryByRole("listbox")).toBeNull();
});
