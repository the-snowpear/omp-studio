import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { StudioJobSnapshot, StudioServiceRow } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { buildBackgroundTasks } from "./backgroundTasksModel";
import { BackgroundTasksPanel, type BackgroundTasksPanelProps, type BackgroundTasksSource } from "./BackgroundTasksPanel";

const service: StudioServiceRow = { name: "shared", instanceId: "service-one", state: "ready", startedAt: 1000, mode: "session", outputBytes: 100, restartCount: 0 };
const job = { jobId: "job-one", generation: 1, ownerAgentId: "main", type: "bash", label: "shared", status: "running", startedAt: new Date(1000).toISOString() } as StudioJobSnapshot;
const failed = { ...job, jobId: "failed-one", label: "Failed check", status: "failed", completedAt: new Date(3000).toISOString() } as StudioJobSnapshot;
function source(): BackgroundTasksSource {
  return { rows: buildBackgroundTasks([job, failed], [service]), servicesState: "ready", servicesError: "", jobsReady: true,
    pending: new Set<string>(), actionErrors: new Map<string, string>(), refresh: vi.fn(async () => {}), stop: vi.fn(async () => {}), canStop: row => row.active };
}
function wrapper(props: BackgroundTasksPanelProps) {
  return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><BackgroundTasksPanel {...props} /></PreviewModeProvider></I18nProvider>;
}
function setup(extra: Partial<BackgroundTasksPanelProps> = {}) {
  const value = source();
  const props: BackgroundTasksPanelProps = { source: value, scopeKey: "one", visible: true, available: true, card: false, now: 6000, onOpenWindow: vi.fn(), onOpenPreview: vi.fn(() => true), ...extra };
  const mounted = render(wrapper(props));
  return { value, props, ...mounted };
}
beforeEach(() => { localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); });
afterEach(() => { cleanup(); localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); vi.restoreAllMocks(); });
it("shows services and jobs in one list and keeps failures discoverable when recent entries are folded", () => {
  setup();
  expect(document.querySelectorAll(".bt-list > .bt-row").length).toBe(2);
  expect(document.querySelectorAll(".bt-row[data-kind='service']").length).toBe(1);
  expect(document.querySelectorAll(".bt-row[data-kind='job']").length).toBe(1);
  expect(screen.getByText("失败 1")).toBeTruthy();
  expect(screen.queryByText("Failed check")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /最近已结束/ }));
  expect(screen.getByText("Failed check")).toBeTruthy();
});
it("stopping does not open details and service stop still requires confirmation", () => {
  const { value } = setup();
  fireEvent.click(document.querySelector<HTMLButtonElement>(".bt-row[data-kind='job'] .bt-stop")!);
  expect(value.stop).toHaveBeenCalledWith(expect.objectContaining({ kind: "job" }));
  expect(document.querySelector<HTMLDivElement>(".bt-list")!.hidden).toBe(false);
  fireEvent.click(document.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-stop")!);
  const dialog = screen.getByRole("dialog", { name: "停止服务" });
  expect(value.stop).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "停止服务" }));
  expect(value.stop).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "service", service: expect.objectContaining({ instanceId: "service-one" }) }));
});
it("a card opens the full window with the selected native identity and reads no details", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  const open = vi.fn();
  const { value } = setup({ card: true, client, onOpenWindow: open });
  fireEvent.click(document.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-task-main")!);
  expect(open).toHaveBeenCalledWith(value.rows.find(row => row.kind === "service")!.key);
  expect(document.querySelector(".bt-detail")).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
});
it("narrow details return to the same row and preserve the expanded recent group", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: /最近已结束/ }));
  const row = document.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-task-main")!;
  fireEvent.click(row);
  expect(document.querySelector<HTMLDivElement>(".bt-list")!.hidden).toBe(true);
  expect(screen.getByText("service-one")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回任务列表" }));
  expect(document.querySelector<HTMLDivElement>(".bt-list")!.hidden).toBe(false);
  expect(screen.getByText("Failed check")).toBeTruthy();
  expect(document.activeElement).toBe(row);
});
it("keeps selected terminal details, then reports native retention instead of silently selecting another task", () => {
  const { props, rerender } = setup();
  fireEvent.click(document.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-task-main")!);
  const terminal = { ...service, state: "exited" as const, exitedAt: 4000, exitCode: 0 };
  rerender(wrapper({ ...props, source: { ...props.source, rows: buildBackgroundTasks([job], [terminal]) } }));
  expect(screen.getByText("service-one")).toBeTruthy();
  rerender(wrapper({ ...props, source: { ...props.source, rows: buildBackgroundTasks([job], []) } }));
  expect(screen.getByText(/此记录已移出最近列表/)).toBeTruthy();
  expect(screen.getByText("service-one")).toBeTruthy();
});
it("a real empty source does not fill in demo rows", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const empty = { ...source(), rows: [] };
  setup({ source: empty });
  expect(screen.getByText("暂无正在运行的任务")).toBeTruthy();
  expect(document.querySelectorAll(".bt-row").length).toBe(0);
});

it("opens the Agent-reported preview directly without any address form or footer", () => {
  const web = { ...service, previewUrl: "http://localhost:5173/" };
  const data = { ...source(), rows: buildBackgroundTasks([job], [web]) };
  const openPage = vi.fn(() => true);
  const openProcess = vi.fn();
  setup({ card: true, source: data, onOpenPreview: openPage, onOpenWindow: openProcess });
  fireEvent.click(document.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-task-main")!);
  expect(openPage).toHaveBeenCalledWith(web.previewUrl, data.rows.find(row => row.kind === "service")!.key);
  expect(openProcess).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector("input")).toBeNull();
  expect(screen.queryByRole("button", { name: "打开窗口" })).toBeNull();
  expect(document.querySelector(".bt-card-footer")).toBeNull();
  expect(document.querySelector(".bt-list")!.lastElementChild?.classList.contains("bt-recent")).toBe(true);
  expect(document.querySelectorAll(".bt-task-icon .icon.sm")).toHaveLength(2);
});

it("keeps process logs reachable from a web service context menu", () => {
  const web = { ...service, previewUrl: "http://localhost:5173/" };
  const data = { ...source(), rows: buildBackgroundTasks([], [web]) };
  const openProcess = vi.fn();
  const openPage = vi.fn(() => true);
  setup({ card: true, source: data, onOpenWindow: openProcess, onOpenPreview: openPage });
  fireEvent.contextMenu(document.querySelector(".bt-row")!, { clientX: 80, clientY: 80 });
  fireEvent.click(screen.getByRole("menuitem", { name: "查看启动过程" }));
  expect(openProcess).toHaveBeenCalledWith(data.rows[0]!.key);
  expect(openPage).not.toHaveBeenCalled();
});

it("falls back to process output when a service has no reported page address", () => {
  const openPage = vi.fn(() => true);
  const openProcess = vi.fn();
  const { value } = setup({ card: true, onOpenWindow: openProcess, onOpenPreview: openPage });
  fireEvent.click(document.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-task-main")!);
  expect(openPage).not.toHaveBeenCalled();
  expect(openProcess).toHaveBeenCalledWith(value.rows.find(row => row.kind === "service")!.key);
  expect(screen.queryByRole("dialog")).toBeNull();
});
