import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JsonValue, StudioClient } from "@omp-studio/client-contract";
import type { JobInspection } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { JobInspector } from "./JobInspector";
import { ToolBody } from "./ToolBody";
import { previewActionsWatch } from "../hubPreview";
import { PreviewModeProvider } from "../preview/PreviewContext";

const receipt = vi.hoisted(() => vi.fn());
vi.mock("../hostError", () => ({ waitReceipt: receipt, hostErrorMessage: () => "Cannot inspect" }));
beforeEach(() => { vi.spyOn(document, "hidden", "get").mockReturnValue(false); receipt.mockReset(); });
const initialUrl = window.location.href;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); window.history.replaceState({}, "", initialUrl); localStorage.clear(); });
const job = { id: "job-a", generation: 1, label: "Compile", status: "running" };
const inspection = { jobId: "job-a", pids: [], output: "finished output" };
function client() {
  return { command: vi.fn(async (_kind: string, payload: { jobId: string }) => ({ requestId: payload.jobId })) } as unknown as StudioClient;
}
function view(value: StudioClient, changes: Partial<Parameters<typeof JobInspector>[0]> = {}) {
  return <I18nProvider forcedLanguage="zh"><JobInspector job={job} client={value} sessionId="session-a" available onClose={() => {}} {...changes} /></I18nProvider>;
}
it.each(["details", "process"] as const)("does not poll a hidden dock, and reads the final output once when a job ends (%s)", async presentation => {
  vi.useFakeTimers();
  receipt.mockResolvedValue({ result: inspection });
  const value = client();
  const mounted = render(view(value, { presentation, visible: false }));
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(value.command).not.toHaveBeenCalled();
  await act(async () => { mounted.rerender(view(value, { presentation, visible: true })); });
  expect(value.command).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(value.command).toHaveBeenCalledTimes(2);
  await act(async () => { mounted.rerender(view(value, { presentation, job: { ...job, status: "completed" } })); });
  expect(value.command).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(value.command).toHaveBeenCalledTimes(3);
  expect(screen.getByText("finished output")).toBeTruthy();
});
it.each(["details", "process"] as const)("discards a late inspection after switching session and job generation (%s)", async presentation => {
  let oldResult!: (value: unknown) => void;
  const old = new Promise(resolve => { oldResult = resolve; });
  receipt.mockReturnValueOnce(old).mockResolvedValue({ result: { ...inspection, output: "new generation output" } });
  const value = client();
  const mounted = render(view(value, { presentation }));
  await act(async () => {});
  await act(async () => { mounted.rerender(view(value, { presentation, sessionId: "session-b", scopeKey: "remote-b", job: { ...job, generation: 2 } })); });
  expect(screen.getByText("new generation output")).toBeTruthy();
  await act(async () => { oldResult({ result: { ...inspection, output: "old generation output" } }); });
  expect(screen.queryByText("old generation output")).toBeNull();
  expect(screen.getByText("new generation output")).toBeTruthy();
  expect(value.command).toHaveBeenLastCalledWith("jobs.inspect", { sessionId: "session-b", jobId: "job-a" });
});
it.each(["details", "process"] as const)("does not write a pending inspection into a panel hidden before the receipt (%s)", async presentation => {
  let resolve!: (value: unknown) => void;
  receipt.mockReturnValue(new Promise(done => { resolve = done; }));
  const value = client();
  const mounted = render(view(value, { presentation }));
  await act(async () => {});
  mounted.rerender(view(value, { presentation, visible: false }));
  await act(async () => { resolve({ result: inspection }); });
  expect(screen.queryByText("finished output")).toBeNull();
});
it.each(["details", "process"] as const)("preview inspection never invokes the runtime (%s)", async presentation => {
  vi.useFakeTimers();
  const value = client();
  render(view(value, { presentation, previewInspection: inspection as never }));
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.getByText("finished output")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  expect(value.command).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
});

it("puts the full command and read-only recent output before folded process metadata", () => {
  const value = client();
  const full = { ...inspection, command: "npm run build --workspace renderer -- --watch", cwd: "/project/renderer", pids: [321, 654], exitCode: 0, artifactId: "artifact-build" };
  const mounted = render(view(value, { presentation: "process", embedded: true, previewInspection: full as never }));
  const output = screen.getByRole("region", { name: "最近输出（只读）" });
  const details = screen.getByText("任务详情").closest("details")!;
  expect(details.open).toBe(false);
  expect(screen.getByText(full.command).closest("details")).toBeNull();
  expect(within(output).getByText(full.output)).toBeTruthy();
  expect(output.tabIndex).toBe(0);
  expect(screen.getByText(/16 KiB，非完整记录/)).toBeTruthy();
  expect(output.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(within(details).getByText(full.cwd)).toBeTruthy();
  expect(within(details).getByText("321, 654")).toBeTruthy();
  expect(within(details).getByText("退出码")).toBeTruthy();
  expect(within(details).getByText("0")).toBeTruthy();
  expect(within(details).getByText("输出产物")).toBeTruthy();
  expect(within(details).getByText(full.artifactId)).toBeTruthy();
  expect(screen.queryByText(job.label)).toBeNull();
  expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  expect(mounted.container.querySelector("input, textarea, [contenteditable=true]")).toBeNull();
  fireEvent.click(screen.getByText("任务详情"));
  expect(details.open).toBe(true);

  // Omitting presentation preserves the existing Agent Hub inspector.
  mounted.rerender(view(value, { previewInspection: full as never }));
  expect(screen.getByLabelText("输出尾部")).toBeTruthy();
  expect(screen.getByText(full.cwd).closest("details")).toBeNull();
  expect(screen.getByText(job.label)).toBeTruthy();
});

it("distinguishes loading, an empty running tail, and an empty finished tail", async () => {
  let resolve!: (value: unknown) => void;
  receipt.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const value = client();
  const mounted = render(view(value, { presentation: "process" }));
  expect(screen.getByText("读取最近输出中…")).toBeTruthy();
  expect(screen.getByRole("region", { name: "最近输出（只读）" }).getAttribute("aria-busy")).toBe("true");
  await act(async () => {});
  await act(async () => { resolve({ result: { ...inspection, output: "" } }); });
  expect(screen.getByText("暂无输出，等待任务写入…")).toBeTruthy();
  expect(screen.getByRole("region", { name: "最近输出（只读）" }).getAttribute("aria-busy")).toBe("false");
  receipt.mockResolvedValue({ result: { ...inspection, output: "" } });
  await act(async () => { mounted.rerender(view(value, { presentation: "process", job: { ...job, status: "completed" } })); });
  expect(screen.getByText("此任务没有可用的最近输出")).toBeTruthy();
});

it("keeps null preview and unavailable Runtime states honest without issuing reads", async () => {
  const value = client();
  const mounted = render(view(value, { presentation: "process", previewInspection: null }));
  await act(async () => {});
  expect(screen.queryByText("读取最近输出中…")).toBeNull();
  expect(screen.getByText("暂无输出，等待任务写入…")).toBeTruthy();
  expect(value.command).not.toHaveBeenCalled();
  mounted.rerender(view(value, { presentation: "process", available: false }));
  expect(screen.getByText(/Runtime 未连接或是历史会话/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "刷新" }).hasAttribute("disabled")).toBe(true);
  expect(value.command).not.toHaveBeenCalled();
});

it("retains the output through an ordinary poll and an error, then replaces it on recovery", async () => {
  vi.useFakeTimers();
  receipt.mockResolvedValueOnce({ result: inspection });
  const value = client();
  render(view(value, { presentation: "process" }));
  await act(async () => {});
  const output = screen.getByRole("region", { name: "最近输出（只读）" });
  let reject!: (cause: Error) => void;
  receipt.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole("region", { name: "最近输出（只读）" })).toBe(output);
  expect(within(output).getByText("finished output")).toBeTruthy();
  expect(screen.queryByText("读取最近输出中…")).toBeNull();
  await act(async () => { reject(new Error("offline")); });
  expect(within(output).getByRole("alert").textContent).toContain("保留上次读取的输出");
  expect(within(output).getByText("finished output")).toBeTruthy();
  receipt.mockResolvedValueOnce({ result: { ...inspection, output: "latest output" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刷新" })); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(within(output).getByText("latest output")).toBeTruthy();
  expect(screen.queryByText("finished output")).toBeNull();
});

it("shows an initial read error in the output area instead of an endless loading state", async () => {
  receipt.mockRejectedValueOnce(new Error("offline"));
  render(view(client(), { presentation: "process" }));
  await act(async () => {});
  const output = screen.getByRole("region", { name: "最近输出（只读）" });
  expect(within(output).getByRole("alert").textContent).toContain("最近输出读取失败");
  expect(screen.queryByText("读取最近输出中…")).toBeNull();
  expect(output.getAttribute("aria-busy")).toBe("false");
});

it("follows output until the reader scrolls up and resumes only at the tail or on request", () => {
  const value = client();
  const props = { presentation: "process" as const, previewInspection: inspection as never };
  const mounted = render(view(value, props));
  const output = screen.getByRole("region", { name: "最近输出（只读）" });
  let height = 1000;
  let top = 0;
  Object.defineProperties(output, {
    clientHeight: { configurable: true, get: () => 200 },
    clientWidth: { configurable: true, get: () => 312 },
    offsetWidth: { configurable: true, get: () => 320 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
  });
  const update = (text: string) => mounted.rerender(view(value, { ...props, previewInspection: { ...inspection, output: text } as never }));
  update("second tail");
  expect(top).toBe(800);
  fireEvent.wheel(output, { deltaY: -80 });
  output.scrollTop = 720;
  fireEvent.scroll(output);
  expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();
  height = 1200;
  update("third tail");
  expect(top).toBe(720);
  fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
  expect(top).toBe(1000);
  expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();

  // Native scrollbar dragging has no wheel event, but must also detach.
  vi.spyOn(output, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 200));
  fireEvent.mouseDown(output, { button: 0, clientX: 319, clientY: 100 });
  output.scrollTop = 900;
  fireEvent.scroll(output);
  update("fourth tail");
  expect(top).toBe(900);
  output.scrollTop = 1000;
  fireEvent.scroll(output);
  height = 1400;
  // Content growth without upward movement is not a reader gesture.
  fireEvent.scroll(output);
  update("fifth tail");
  expect(top).toBe(1200);
  height = 700; output.scrollTop = 500; fireEvent.scroll(output);
  expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
  height = 900; update("tail after truncation"); expect(top).toBe(700);
  expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
  expect(value.command).not.toHaveBeenCalled();
});

it.each(["details", "process"] as const)("puts the native failed-step summary and ordered steps before original output, without estimating unknown time (%s)", presentation => {
  const value = client();
  const full: JobInspection = { ...inspection, actions: previewActionsWatch(true) };
  render(view(value, { presentation, previewInspection: full, job: { ...job, status: "failed" } }));
  const actions = screen.getByRole("region", { name: "GitHub Actions 步骤" });
  const steps = within(actions).getByText("Windows · renderer").closest("details")!;
  expect(steps.open).toBe(false);
  expect(steps.querySelector("summary")?.textContent).toContain("失败步骤 · #3");
  fireEvent.click(steps.querySelector("summary")!);
  expect(steps.open).toBe(true);
  const ordered = within(steps).getByRole("list", { name: "Windows · renderer 有序步骤" });
  expect(Array.from(ordered.children).map(row => (row as HTMLLIElement).value)).toEqual([1, 2, 3, 4]);
  expect(within(ordered.children[1] as HTMLElement).getByText("0s").getAttribute("datetime")).toBe("PT0S");
  expect(within(ordered.children[2] as HTMLElement).getByText("耗时未知")).toBeTruthy();
  expect(within(ordered.children[2] as HTMLElement).getByText("失败")).toBeTruthy();
  expect(within(actions).queryByRole("progressbar")).toBeNull();
  const output = presentation === "process" ? screen.getByRole("region", { name: "最近输出（只读）" }) : screen.getByLabelText("输出尾部");
  expect(actions.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  const log = within(actions).getByText(/日志.*Windows.*24817/).closest("details")!;
  fireEvent.click(log.querySelector("summary")!);
  expect(within(log).getByText(/Expected native result metadata/)).toBeTruthy();
  expect(value.command).not.toHaveBeenCalled();
});

it("the foreground GitHub tool uses the same native steps and ignores a submitted watch object", () => {
  const native = previewActionsWatch(true) as unknown as JsonValue;
  render(<I18nProvider forcedLanguage="zh"><ToolBody tool={{
    toolCallId: "foreground-watch", toolName: "github", status: "failed",
    arguments: { op: "run_watch", watch: { mode: "run", repo: "forged/repo", state: "completed", run: { id: 99, jobs: [{ id: 99, name: "FORGED STEP", steps: [] }] } } },
    result: { type: "toolResult", toolCallId: "foreground-watch", isError: true, data: { watch: native, output: "original native watch output" } },
  }} /></I18nProvider>);
  const actions = screen.getByRole("region", { name: "GitHub Actions 步骤" });
  expect(within(actions).getByText("the-snowpear/omp-studio")).toBeTruthy();
  expect(within(actions).queryByText("FORGED STEP")).toBeNull();
  expect(screen.getByText(/original native watch output/)).toBeTruthy();
});

it("keeps the last native observation clear after cancellation, including failure logs from a display-budget omitted run", () => {
  const full: JobInspection = { ...inspection, actions: {
    mode: "run", repo: "owner/project", state: "watching", runs: [], truncated: true,
    failedLogs: [{ runId: 999, jobId: 9991, jobName: "omitted job", available: true, tail: "original omitted-run failure" }],
  } };
  render(view(client(), { previewInspection: full, job: { ...job, status: "cancelled" } }));
  expect(screen.getByText(/父 Job 已结束/)).toBeTruthy();
  const log = screen.getByText(/日志.*omitted job.*999/).closest("details")!;
  fireEvent.click(log.querySelector("summary")!);
  expect(within(log).getByText("original omitted-run failure")).toBeTruthy();
  expect(screen.getByText(/当前仅显示原生快照的一部分/)).toBeTruthy();
});

it("marks=off hides only demo chrome, not native Actions state or unknown durations", () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const value = client();
  render(<PreviewModeProvider switchEnabled>{view(value, { previewInspection: { ...inspection, actions: previewActionsWatch() } })}</PreviewModeProvider>);
  expect(screen.queryByText("演示")).toBeNull();
  expect(screen.getByRole("region", { name: "GitHub Actions 步骤" })).toBeTruthy();
  expect(screen.getAllByText("耗时未知").length).toBeGreaterThan(0);
  expect(value.command).not.toHaveBeenCalled();
});

it("pauses reads in a hidden document and discards an observation spanning hide/show before requesting the fresh tail", async () => {
  vi.useFakeTimers();
  let hidden = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  let resolveFirst!: (value: { result: typeof inspection }) => void;
  const first = new Promise<{ result: typeof inspection }>(resolve => { resolveFirst = resolve; });
  receipt.mockReturnValueOnce(first).mockResolvedValue({ result: { ...inspection, output: "fresh observation" } });
  const value = client();
  render(view(value, { presentation: "process" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(value.command).not.toHaveBeenCalled();
  hidden = false;
  await act(async () => { fireEvent(document, new Event("visibilitychange")); });
  expect(value.command).toHaveBeenCalledTimes(1);
  hidden = true; fireEvent(document, new Event("visibilitychange"));
  hidden = false; fireEvent(document, new Event("visibilitychange"));
  await act(async () => { resolveFirst({ result: { ...inspection, output: "stale observation" } }); });
  expect(screen.queryByText("stale observation")).toBeNull();
  expect(screen.getByText("fresh observation")).toBeTruthy();
  hidden = true; fireEvent(document, new Event("visibilitychange"));
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(value.command).toHaveBeenCalledTimes(2);
});
