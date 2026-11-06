import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, ClientEvent, CommandState, StudioClient } from "@omp-studio/client-contract";
import type { ComputerFrame, ComputerWorkspaceChange, ComputerWorkspaceSnapshot } from "@omp-studio/studio-protocol";
import { ComputerPane } from "../browser/ComputerPane";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { buildComputerPreview, previewComputerFrame } from "../preview/computerPreview";
import { SurfaceProvider } from "../dock/SurfaceContext";
import type { ComputerPaneProps } from "./types";
import { computerWorkspaceSource } from "./workspaceSource";

const ids = ["computer.workspace.get", "computer.activity.list", "computer.frame.get", "computer.structure.get", "computer.observe.open", "computer.observe.close", "computer.frame.capture", "computer.control.stop", "computer.control.continue", "preferences.features.get", "preferences.features.set", "preferences.features.clearOverride"];
const capabilities: ClientBootstrap["capabilityManifest"] = { profile: "limited", hash: "computer-workspace", generatedAt: "2026-11-05T00:00:00Z", capabilities: ids.map(id => ({ id, grade: "stable", version: 1, evidence: "test" })) };
function mockClient(initial: ComputerWorkspaceSnapshot = buildComputerPreview("root").snapshot) {
  let snapshot = initial, counter = 0;
  const listeners = new Set<(event: ClientEvent) => void>();
  const commands: Record<string, CommandState> = {};
  const query = vi.fn(async (kind: string, input: any): Promise<any> => {
    if (kind === "computer.workspace.get") return snapshot;
    if (kind === "computer.activity.list") return { items: buildComputerPreview(snapshot.sessionId).actions, frames: snapshot.frames, revision: snapshot.revision };
    if (kind === "computer.frame.get") return snapshot.frames.find(frame => frame.frameId === input.frameId) ?? null;
    return undefined;
  });
  const command = vi.fn(async (kind: string, input: any) => {
    const requestId = `command-${++counter}`;
    const control = kind === "computer.control.stop" ? { ...snapshot.control, status: "stopped", revision: snapshot.control.revision + 1 } : { ...snapshot.control, status: "continuing" };
    const result = kind === "computer.observe.open" ? { leaseId: `lease-${counter}`, sessionId: snapshot.sessionId, expiresAt: Date.now() + 120000 }
      : kind === "computer.observe.close" ? { released: true }
      : kind === "computer.frame.capture" ? { ...previewComputerFrame(snapshot.sessionId, counter), source: "observation", targetId: input.targetId, delivered: false }
      : kind === "computer.control.stop" ? control
      : kind === "computer.control.continue" ? { queued: true, control }
      : kind === "preferences.features.get" ? { settings: [] } : { key: input.key, value: input.value, source: input.scope === "session" ? "runtime" : "global" };
    commands[requestId] = { requestId, commandName: kind, status: "completed", observedAt: "2026-11-05T00:00:00Z", result: { result } } as CommandState;
    return { requestId };
  });
  const subscribe = vi.fn((_scope: unknown, listener: (event: ClientEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  const client = { query, command, subscribe, getState: () => ({ commands }) } as unknown as StudioClient;
  return { client, query, command, subscribe, setSnapshot(value: ComputerWorkspaceSnapshot) { snapshot = value; }, emit(change: ComputerWorkspaceChange) { const event = { kind: "computer.changed", change, authorityEpoch: "authority", runtimeEpoch: "runtime", stateVersion: 1, cursor: String(change.revision), occurredAt: "2026-11-05T00:00:00Z" } as unknown as ClientEvent; for (const listener of listeners) listener(event); } };
}
function pane(client: StudioClient, props: Partial<Omit<ComputerPaneProps, "client">> = {}) {
  return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ComputerPane client={client} sessionId="root" scopeKey="epoch-1" executionTarget={{ kind: "local" }} available visible width={1000} height={650} capabilities={capabilities} {...props} /></PreviewModeProvider></I18nProvider>;
}
beforeEach(() => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:frame-${Math.random()}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ompStudioChrome", { readComputerFrame: vi.fn(async () => ({ ok: true, data: new ArrayBuffer(8), width: 1280, height: 800, mimeType: "image/png" })), saveComputerFrame: vi.fn(async () => ({ ok: true, artifactId: "saved" })) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it("follows existing execution frames without opening an observation lease", async () => {
  const api = mockClient(); render(pane(api.client));
  await screen.findByAltText("电脑目标截图");
  expect(api.query).toHaveBeenCalledWith("computer.workspace.get", { sessionId: "root" });
  expect(api.command).not.toHaveBeenCalled();
  expect(api.subscribe.mock.calls[0]?.[0]).toEqual({ scope: "runtime" });
  expect(screen.getByText("运行电脑脚本", { selector: "strong" })).toBeTruthy();
  expect(screen.queryByText("正在使用前台控制")).toBeNull();
});
it("keeps a historical frame selected when a new execution frame arrives", async () => {
  const api = mockClient(); render(pane(api.client));
  await screen.findByAltText("电脑目标截图");
  fireEvent.click(screen.getByRole("button", { name: /读取画面.*OMP Studio/ }));
  await screen.findByText("正在查看历史");
  const read = window.ompStudioChrome!.readComputerFrame as ReturnType<typeof vi.fn>;
  await waitFor(() => expect(read).toHaveBeenLastCalledWith({ scopeSessionId: "root", frameId: "computer-preview-frame-1", origin: "local" }));
  const frame = previewComputerFrame("root", 8);
  act(() => api.emit({ sessionId: "root", revision: 9, kind: "frame", frame }));
  expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ frameId: frame.frameId }));
  fireEvent.click(screen.getByRole("button", { name: "回到当前" }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith({ scopeSessionId: "root", frameId: frame.frameId, origin: "local" }));
});
it("shows steps without frames honestly and never captures a replacement", async () => {
  const api = mockClient(); render(pane(api.client));
  fireEvent.click(await screen.findByRole("button", { name: /查找窗口/ }));
  expect(screen.queryByAltText("电脑目标截图")).toBeNull();
  expect(screen.getByRole("heading", { name: "此步骤没有截图" })).toBeTruthy();
  expect(api.command).not.toHaveBeenCalled();
});
it("passes handoff intent and the exact stopped revision to continue, without treating queued as resumed", async () => {
  const api = mockClient(); render(pane(api.client));
  await screen.findByAltText("电脑目标截图");
  fireEvent.click(screen.getByRole("button", { name: "我来操作" }));
  await screen.findByText("本会话电脑操作已停止");
  expect(api.command).toHaveBeenCalledWith("computer.control.stop", { sessionId: "root", reason: "handoff" });
  fireEvent.click(screen.getByRole("button", { name: "允许本会话继续电脑操作" }));
  await waitFor(() => expect(api.command).toHaveBeenCalledWith("computer.control.continue", { sessionId: "root", revision: 4 }));
  await screen.findByText("继续请求已进入对话队列，尚未恢复电脑操作。");
  expect(screen.queryByText("允许新的电脑调用")).toBeNull();
});
it("only reads a child frame through its workspace root and saves on explicit click", async () => {
  const snapshot = buildComputerPreview("root").snapshot;
  snapshot.frames = [{ ...previewComputerFrame("child", 2), agentId: "child-agent" }];
  const api = mockClient(snapshot); render(pane(api.client));
  await screen.findByAltText("电脑目标截图");
  expect(window.ompStudioChrome!.readComputerFrame).toHaveBeenCalledWith({ scopeSessionId: "root", frameId: "computer-preview-frame-2", origin: "local" });
  expect(window.ompStudioChrome!.saveComputerFrame).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存到产物库" }));
  await waitFor(() => expect(window.ompStudioChrome!.saveComputerFrame).toHaveBeenCalledWith({ scopeSessionId: "root", frameId: "computer-preview-frame-2", origin: "local" }));
});
it("never reads a remote frame through the local desktop channel", async () => {
  const api = mockClient(); render(pane(api.client, { executionTarget: { kind: "remote", name: "Build Mac" } }));
  await screen.findByText(/此远端连接只提供画面元数据/);
  expect(window.ompStudioChrome!.readComputerFrame).not.toHaveBeenCalled();
  expect(screen.getByText(/Build Mac/)).toBeTruthy();
});
it("drops a late image read after switching session", async () => {
  let resolve!: (value: unknown) => void;
  const read = vi.fn(() => new Promise(done => { resolve = done; }));
  vi.stubGlobal("ompStudioChrome", { readComputerFrame: read });
  const api = mockClient(); const view = render(pane(api.client));
  await waitFor(() => expect(read).toHaveBeenCalled());
  view.rerender(pane(api.client, { sessionId: "another", available: false }));
  await act(async () => resolve({ ok: true, data: new ArrayBuffer(8), width: 1280, height: 800, mimeType: "image/png" }));
  expect(screen.queryByAltText("电脑目标截图")).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("shares one subscription and observer for two visible consumers and closes the last lease", async () => {
  vi.useFakeTimers();
  const api = mockClient(); const source = computerWorkspaceSource(api.client, "root", "shared");
  const a = source.subscribe(() => {}), b = source.subscribe(() => {});
  await source.refresh();
  expect(api.subscribe).toHaveBeenCalledTimes(1);
  const offA = source.observe("demo-window", () => {}), offB = source.observe("demo-window", () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(api.command.mock.calls.filter(call => call[0] === "computer.observe.open")).toHaveLength(1);
  expect(api.command.mock.calls.filter(call => call[0] === "computer.frame.capture")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(api.command.mock.calls.filter(call => call[0] === "computer.frame.capture")).toHaveLength(1);
  offA(); a();
  expect(api.command.mock.calls.filter(call => call[0] === "computer.observe.close")).toHaveLength(0);
  offB(); b();
  await Promise.resolve();
  expect(api.command.mock.calls.filter(call => call[0] === "computer.observe.close")).toHaveLength(1);
});
it("stops extra observation after thirty idle seconds", async () => {
  vi.useFakeTimers();
  const snapshot = buildComputerPreview("root", "history").snapshot;
  const api = mockClient(snapshot), source = computerWorkspaceSource(api.client, "root", "idle");
  const off = source.subscribe(() => {}); await source.refresh();
  const update = vi.fn(), stop = source.observe("demo-window", update);
  await vi.advanceTimersByTimeAsync(31000);
  expect(api.command.mock.calls.filter(call => call[0] === "computer.frame.capture")).toHaveLength(6);
  expect(update).toHaveBeenLastCalledWith({ paused: true });
  await vi.advanceTimersByTimeAsync(60000);
  expect(api.command.mock.calls.filter(call => call[0] === "computer.frame.capture")).toHaveLength(6);
  stop(); off();
});
it("refetches a snapshot for a gap instead of applying a partial change", async () => {
  const api = mockClient(), source = computerWorkspaceSource(api.client, "root", "gap");
  const off = source.subscribe(() => {}); await source.refresh();
  api.emit({ sessionId: "root", kind: "frame", revision: 20, frame: previewComputerFrame("root", 20) });
  await source.refresh();
  expect(api.query.mock.calls.filter(call => call[0] === "computer.workspace.get")).toHaveLength(2);
  expect(source.getSnapshot().frames.some(frame => frame.frameId === "computer-preview-frame-20")).toBe(false);
  off();
});
it("preview controls and settings never write or query the Host", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const api = mockClient(); render(pane(api.client));
  fireEvent.click(screen.getByRole("button", { name: "停止电脑操作" }));
  fireEvent.click(await screen.findByRole("button", { name: "允许本会话继续电脑操作" }));
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  fireEvent.click(screen.getByRole("switch", { name: "允许电脑操作" }));
  expect(api.command).not.toHaveBeenCalled(); expect(api.query).not.toHaveBeenCalled(); expect(api.subscribe).not.toHaveBeenCalled();
});
it("retains an always-reachable stop in a low-height panel", async () => {
  const api = mockClient(); const view = render(pane(api.client, { width: 330, height: 190 }));
  await screen.findByAltText("电脑目标截图");
  expect(view.container.querySelector('.computer-workspace[data-low="true"] > .cw-header')?.contains(screen.getByRole("button", { name: "停止电脑操作" }))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "停止电脑操作" }));
  expect(api.command).toHaveBeenCalledWith("computer.control.stop", { sessionId: "root", reason: "stop" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("uses the owning surface's private image channel", async () => {
  const iframe = document.createElement("iframe"); document.body.append(iframe);
  const other = iframe.contentDocument!;
  const read = vi.fn(async () => ({ ok: true, data: new ArrayBuffer(8), width: 1280, height: 800, mimeType: "image/png" }));
  Object.assign(other.defaultView!, { ompStudioChrome: { readComputerFrame: read } });
  Object.assign(other.defaultView!.URL, { createObjectURL: vi.fn(() => "blob:other"), revokeObjectURL: vi.fn() });
  const api = mockClient(); const view = render(<SurfaceProvider document={other}>{pane(api.client)}</SurfaceProvider>);
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(window.ompStudioChrome!.readComputerFrame).not.toHaveBeenCalled();
  view.unmount(); iframe.remove();
});

it("does not read or recapture an expired historical image", async () => {
  const api = mockClient(buildComputerPreview("root", "expired").snapshot);
  render(pane(api.client));
  await screen.findByText("图像已过期或未保存。此处不会补拍冒充历史画面。");
  expect(window.ompStudioChrome!.readComputerFrame).not.toHaveBeenCalled();
  expect(api.command).not.toHaveBeenCalled();
});
it("opens structure only on demand and highlights only its own frame coordinates", async () => {
  const api = mockClient();
  const original = api.query.getMockImplementation()!;
  const structureFrame: ComputerFrame = { ...previewComputerFrame("root", 22), capturedAt: Date.now(), source: "observation", delivered: false };
  api.query.mockImplementation(async (kind, input) => kind === "computer.structure.get" ? {
    snapshotId: "structure-1", sessionId: "root", targetId: "demo-window", capturedAt: Date.now(), coordinateSpace: "unavailable", truncated: true,
    frame: structureFrame, nodes: [{ id: "confirm", role: "button", name: "Confirm", enabled: true, bounds: { x: 10, y: 20, width: 40, height: 30 }, children: [] }],
  } : original(kind, input));
  const view = render(pane(api.client));
  await screen.findByAltText("电脑目标截图");
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  expect(api.query.mock.calls.some(([kind]) => kind === "computer.structure.get")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "读取界面结构" }));
  fireEvent.click(await screen.findByRole("button", { name: /Confirm/ }));
  expect(api.query).toHaveBeenCalledWith("computer.structure.get", { sessionId: "root", leaseId: expect.any(String), targetId: "demo-window" });
  expect(view.container.querySelector(".cw-highlight")).toBeNull();
  expect(screen.getByText("结构已截断")).toBeTruthy();
  expect(api.command.mock.calls.some(([kind]) => kind.includes("input"))).toBe(false);
});
it("closes an observation lease whose open finishes after the final consumer hides", async () => {
  const api = mockClient(), source = computerWorkspaceSource(api.client, "root", "late-lease");
  let release!: () => void;
  const original = api.command.getMockImplementation()!;
  api.command.mockImplementation(async (kind, input) => {
    if (kind === "computer.observe.open") await new Promise<void>(resolve => { release = resolve; });
    return original(kind, input);
  });
  const off = source.subscribe(() => {}); await source.refresh();
  const pending = source.capture("demo-window").catch(() => undefined);
  await waitFor(() => expect(api.command).toHaveBeenCalledWith("computer.observe.open", expect.anything()));
  off(); release(); await pending;
  await waitFor(() => expect(api.command.mock.calls.some(([kind]) => kind === "computer.observe.close")).toBe(true));
  expect(api.command.mock.calls.some(([kind]) => kind === "computer.frame.capture")).toBe(false);
});
it("does not restart observation on an ordinary panel rerender", async () => {
  const api = mockClient(), view = render(pane(api.client));
  await screen.findByAltText("电脑目标截图");
  fireEvent.click(screen.getByRole("switch", { name: "自动观察" }));
  await waitFor(() => expect(api.command.mock.calls.filter(([kind]) => kind === "computer.observe.open")).toHaveLength(1));
  view.rerender(pane(api.client, { width: 900 }));
  expect(api.command.mock.calls.filter(([kind]) => kind === "computer.observe.open")).toHaveLength(1);
  expect(api.subscribe).toHaveBeenCalledTimes(1);
});
it("keeps demo-only markings hidden with marks off", async () => {
  const before = window.location.href;
  window.history.replaceState(null, "", "?preview=1&marks=off");
  try {
    const api = mockClient(); render(pane(api.client));
    await screen.findByAltText("电脑目标截图");
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.queryByText(/演示|Demo/)).toBeNull();
    expect(api.command).not.toHaveBeenCalled(); expect(api.query).not.toHaveBeenCalled();
  } finally { window.history.replaceState(null, "", before); }
});

it("lets stop supersede a pending continue without applying its late receipt", async () => {
  const api = mockClient(buildComputerPreview("root", "stopped").snapshot);
  const original = api.command.getMockImplementation()!;
  let release!: () => void;
  api.command.mockImplementation(async (kind, input) => {
    if (kind === "computer.control.continue") await new Promise<void>(resolve => { release = resolve; });
    return original(kind, input);
  });
  render(pane(api.client));
  await screen.findByAltText("电脑目标截图");
  fireEvent.click(screen.getByRole("button", { name: "允许本会话继续电脑操作" }));
  expect(api.command).toHaveBeenCalledWith("computer.control.continue", { sessionId: "root", revision: 3 });
  fireEvent.click(screen.getByRole("button", { name: "停止电脑操作" }));
  await waitFor(() => expect(api.command).toHaveBeenCalledWith("computer.control.stop", { sessionId: "root", reason: "stop" }));
  await act(async () => { release(); });
  await screen.findByText("本会话电脑操作已停止");
  expect(screen.queryByText("继续请求已进入对话队列，尚未恢复电脑操作。")).toBeNull();
});
