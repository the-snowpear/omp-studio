import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { GcStatus } from "@omp-studio/studio-protocol";
import * as hostErrors from "../hostError";
import { previewGc } from "../preview/maintenancePreview";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { NativeMaintenancePane } from "./NativeMaintenancePane";
const initialUrl = window.location.href;
beforeEach(() => { vi.spyOn(document, "hidden", "get").mockReturnValue(false); });
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", initialUrl);
});
const capabilities: ClientBootstrap["capabilityManifest"] = {
  profile: "limited", generatedAt: "2026-11-12T12:00:00.000Z", hash: "isolated-maintenance",
  capabilities: ["maintenance.gc.preview", "maintenance.gc.apply", "maintenance.gc.status", "maintenance.export.status"].map(id => ({ id, grade: "stable" as const, version: 1, evidence: "isolated service" })),
};
function nativeClient(respond: (kind: string, input: unknown) => unknown) {
  const pending = new Map<string, Promise<unknown>>();
  let next = 0;
  const command = vi.fn(async (kind: string, input: unknown) => {
    const requestId = `maintenance-${++next}`;
    pending.set(requestId, Promise.resolve(respond(kind, input)).then(result => ({ result })));
    return { requestId };
  });
  const receipt: typeof hostErrors.waitReceipt = <T,>(_client: Pick<StudioClient, "subscribe">, requestId: string) =>
    pending.get(requestId)! as Promise<T>;
  vi.spyOn(hostErrors, "waitReceipt").mockImplementation(receipt);
  return { command, query: vi.fn() } as unknown as StudioClient;
}
function view(client: StudioClient, options: Partial<Parameters<typeof NativeMaintenancePane>[0]> = {}) {
  return (
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <NativeMaintenancePane client={client} available active sessionId="s" {...options} />
      </PreviewModeProvider>
    </I18nProvider>
  );
}
it("previews cleanup, confirms it explicitly, and exports locally without any real writes", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(view(client));
  expect(screen.queryByRole("button", { name: "确认清理…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认清理…" }));
  expect(screen.getByRole("dialog", { name: "确认 OMP 数据清理" })).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "执行清理" }));
  await screen.findByText("演示清理完成，未修改任何文件。");
  fireEvent.click(screen.getByRole("button", { name: "导出当前会话" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成导出文件" }));
  fireEvent.click(await screen.findByRole("button", { name: "另存副本…" }));
  await screen.findByText("演示产物不会写入本机。");
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it("keeps all native writes disabled when maintenance capabilities are absent", () => {
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(view(client));
  for (const name of ["导出当前会话", "扫描并预览", "检查连接"]) {
    expect(
      (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
  }
  expect(client.command).not.toHaveBeenCalled();
});

it("scans and applies replay stripping separately from the four storage categories, and invalidates its preview on an option change", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(view(client));
  const storage = screen.getByRole("group", { name: "清理范围" });
  expect(within(storage).getAllByRole("checkbox")).toHaveLength(4);
  for (const name of ["无引用附件", "冷会话归档", "数据库日志"]) fireEvent.click(screen.getByRole("checkbox", { name }));
  fireEvent.click(screen.getByRole("checkbox", { name: "移除供应商回放信息" }));
  fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
  expect(await screen.findByRole("table", { name: "回放信息扫描结果" })).toBeTruthy();
  expect(screen.queryByText("类别")).toBeNull();
  fireEvent.change(screen.getByRole("spinbutton", { name: "空闲天数" }), { target: { value: "12" } });
  expect(screen.queryByRole("button", { name: "确认清理…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认清理…" }));
  const confirm = screen.getByRole("dialog", { name: "确认 OMP 数据清理" });
  expect(within(confirm).getByText(/空闲至少 12 天/)).toBeTruthy();
  expect(within(confirm).queryByText(/删除无引用附件/)).toBeNull();
  fireEvent.click(within(confirm).getByRole("button", { name: "执行清理" }));
  await screen.findByText("演示清理完成，未修改任何文件。");
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});

it("the real surface forwards explicit strip options and the confirmed token, then shows native rewritten counts rather than candidate counts", async () => {
  const plan = { ...previewGc([], { idleDays: 12 }), token: "native-preview" };
  const client = nativeClient(kind => kind === "maintenance.gc.preview" ? plan : kind === "maintenance.gc.apply"
    ? { ...plan.summary, applied: true, strip: { ...plan.summary.strip!, changed: 2, skippedActive: 3 } }
    : { phase: "idle" });
  render(view(client, { capabilities }));
  await act(async () => {});
  for (const name of ["无引用附件", "冷会话归档", "数据库日志"]) fireEvent.click(screen.getByRole("checkbox", { name }));
  fireEvent.click(screen.getByRole("checkbox", { name: "移除供应商回放信息" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "空闲天数" }), { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认清理…" }));
  fireEvent.click(screen.getByRole("button", { name: "执行清理" }));
  await waitFor(() => {
    const table = screen.getByRole("table", { name: "回放信息扫描结果" });
    expect(table.querySelector("tbody tr")?.children[2]?.textContent).toBe("2");
  });
  expect(client.command).toHaveBeenCalledWith("maintenance.gc.preview", { sessionId: "s", categories: [], strip: { idleDays: 12 } });
  expect(client.command).toHaveBeenCalledWith("maintenance.gc.apply", { sessionId: "s", token: "native-preview" });
  expect(screen.queryByText("演示清理完成，未修改任何文件。")).toBeNull();
});

it("does not pretend an older Runtime supported replay stripping when its preview omitted the strip result", async () => {
  const client = nativeClient(kind => kind === "maintenance.gc.preview" ? previewGc(["blobs", "archive", "wal"]) : { phase: "idle" });
  render(view(client, { capabilities }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("checkbox", { name: "移除供应商回放信息" }));
  fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
  expect(await screen.findByText(/此 Runtime 未提供供应商回放信息预览/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "确认清理…" })).toBeNull();
  expect(screen.queryByRole("table", { name: "回放信息扫描结果" })).toBeNull();
  expect(client.command).not.toHaveBeenCalledWith("maintenance.gc.apply", expect.anything());
});

it("does not revive an old preview from a late status read after changing options or hiding the surface", async () => {
  let resolve!: (value: GcStatus) => void;
  const old = new Promise<GcStatus>(done => { resolve = done; });
  let reads = 0;
  const client = nativeClient(kind => kind === "maintenance.gc.status" && ++reads === 1 ? old : { phase: "idle" });
  const mounted = render(view(client, { capabilities, active: false }));
  await act(async () => {});
  expect(client.command).not.toHaveBeenCalled();
  await act(async () => { mounted.rerender(view(client, { capabilities, active: true })); });
  fireEvent.click(screen.getByRole("checkbox", { name: "移除供应商回放信息" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "空闲天数" }), { target: { value: "12" } });
  mounted.rerender(view(client, { capabilities, active: false }));
  await act(async () => { resolve({ phase: "complete", preview: previewGc(["blobs"]), summary: previewGc(["blobs"]).summary }); });
  expect(screen.queryByRole("button", { name: "确认清理…" })).toBeNull();
  await act(async () => { mounted.rerender(view(client, { capabilities, active: true })); });
  expect(screen.queryByRole("button", { name: "确认清理…" })).toBeNull();
});

it("marks=off hides demo-only maintenance text but retains the replay-removal scope and confirmation", async () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(view(client));
  fireEvent.click(screen.getByRole("checkbox", { name: "移除供应商回放信息" }));
  fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认清理…" }));
  expect(screen.queryByText("演示")).toBeNull();
  expect(screen.queryByText("演示操作不会修改真实文件。")).toBeNull();
  expect(screen.getByText(/正文和最新回放轮次保留/)).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
});
