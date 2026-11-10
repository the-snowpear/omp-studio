/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientEvent, StudioClient } from "@omp-studio/client-contract";
import type { StudioJobSnapshot, StudioServiceRow } from "@omp-studio/studio-protocol";
import { PREVIEW_BACKGROUND_JOBS, PREVIEW_BACKGROUND_SERVICES } from "../preview/backgroundTasksPreview";
import { useBackgroundTasks, type BackgroundTasksOptions } from "./useBackgroundTasks";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const startedAt = Date.parse("2026-11-09T10:00:00Z");
const running: StudioJobSnapshot = {
  jobId: "shared" as StudioJobSnapshot["jobId"],
  generation: 7 as StudioJobSnapshot["generation"],
  ownerAgentId: "main" as StudioJobSnapshot["ownerAgentId"],
  type: "bash", label: "Type check", status: "running", startedAt: new Date(startedAt).toISOString(),
};
const web: StudioServiceRow = {
  name: "shared", instanceId: "web-instance-2", state: "ready", startedAt,
  restartCount: 1, outputBytes: 320, mode: "session", ownerId: "live",
};

type SentCommand = { requestId: string; kind: string; payload: unknown };
function clientFixture(initialServices: StudioServiceRow[] = [web]) {
  const sent: SentCommand[] = [];
  const receipts: Record<string, unknown> = {};
  const listeners = new Map<string, (event: ClientEvent) => void>();
  let automaticLists = true;
  let services = initialServices;
  const command = vi.fn(async (kind: string, payload: unknown) => {
    const requestId = `request-${sent.length + 1}`;
    sent.push({ requestId, kind, payload });
    if (kind === "services.list" && automaticLists) {
      receipts[requestId] = { requestId, status: "completed", result: { result: { enabled: true, services } } };
    }
    return { requestId };
  });
  const client = {
    command,
    getState: () => ({ commands: receipts }),
    subscribe: ({ requestId }: { requestId: string }, listener: (event: ClientEvent) => void) => {
      listeners.set(requestId, listener);
      return () => { listeners.delete(requestId); };
    },
  } as unknown as StudioClient;
  const settle = (sentCommand: SentCommand, status: "completed" | "failed", value: unknown) => {
    const receipt = { requestId: sentCommand.requestId, status, ...(status === "completed" ? { result: value } : { error: value }) };
    receipts[sentCommand.requestId] = receipt;
    listeners.get(sentCommand.requestId)?.({ kind: "command.receipt", receipt } as unknown as ClientEvent);
  };
  return {
    client, command, sent,
    holdLists: () => { automaticLists = false; },
    setServices: (value: StudioServiceRow[]) => { services = value; },
    latest: (kind: string) => sent.filter((item) => item.kind === kind).at(-1)!,
    complete: (request: SentCommand, value: unknown) => settle(request, "completed", value),
    fail: (request: SentCommand, message: string) => settle(request, "failed", { message }),
    listResult: (request: SentCommand, rows: StudioServiceRow[], enabled = true) => settle(request, "completed", { result: { enabled, services: rows } }),
  };
}
function visibility() {
  let hidden = false;
  const target = new EventTarget();
  Object.defineProperty(target, "hidden", { get: () => hidden });
  return {
    document: target as Document,
    setHidden: (value: boolean) => { hidden = value; target.dispatchEvent(new Event("visibilitychange")); },
  };
}
function options(client: StudioClient, patch: Partial<BackgroundTasksOptions> = {}): BackgroundTasksOptions {
  return {
    client, scopeKey: "local/workspace", sessionId: "live", mainAgentId: "main", jobs: [running], jobsReady: true,
    available: true, canListServices: true, canStopServices: true, canCancelJobs: true,
    active: true, preview: false, document: visibility().document, ...patch,
  };
}
const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("preview stops both sources locally and refresh never resurrects them or calls Host", async () => {
  const f = clientFixture();
  const input = options(f.client, { preview: true, available: false, jobsReady: false });
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  const job = result.current.rows.find((row) => row.kind === "job" && row.active)!;
  const service = result.current.rows.find((row) => row.kind === "service" && row.active)!;
  expect(result.current.jobsReady).toBe(true);
  expect(result.current.servicesState).toBe("ready");
  await act(async () => { await result.current.stop(job); await result.current.stop(service); });
  await act(async () => { await result.current.refresh(); });
  rerender({ ...input, jobs: [{ ...running }] });
  await advance(8000);
  expect(result.current.rows.find((row) => row.key === job.key)?.state).toBe("cancelled");
  expect(result.current.rows.find((row) => row.key === service.key)?.state).toBe("exited");
  expect(result.current.rows.find((row) => row.key === job.key)?.startedAt).toBe(job.startedAt);
  expect(result.current.pending.size).toBe(0);
  expect(f.command).not.toHaveBeenCalled();
  expect(PREVIEW_BACKGROUND_JOBS.find((row) => row.jobId === job.job?.jobId)?.status).toBe("running");
  expect(PREVIEW_BACKGROUND_SERVICES.find((row) => row.instanceId === service.service?.instanceId)?.state).toBe("ready");
});

it("keeps source errors separate, preserves loaded rows, and does not turn unknown jobs into ready zero", async () => {
  const f = clientFixture();
  const input = options(f.client);
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  expect(result.current.rows).toHaveLength(2);
  f.holdLists();
  let refresh!: Promise<void>;
  act(() => { refresh = result.current.refresh(); });
  await act(async () => { f.fail(f.latest("services.list"), "Service broker unavailable"); await refresh; });
  expect(result.current.servicesState).toBe("error");
  expect(result.current.servicesError).toBe("Service broker unavailable");
  expect(result.current.rows.find((row) => row.kind === "job")?.job).toBe(running);
  expect(result.current.rows.find((row) => row.kind === "service")?.service).toBe(web);
  rerender({ ...input, jobsReady: false, jobs: [] });
  expect(result.current.jobsReady).toBe(false);
  expect(result.current.rows.map((row) => row.kind)).toEqual(["service"]);
  act(() => { refresh = result.current.refresh(); });
  await act(async () => { f.listResult(f.latest("services.list"), [web]); await refresh; });
  expect(result.current.servicesState).toBe("ready");
  expect(result.current.servicesError).toBe("");
  expect(result.current.jobsReady).toBe(false);
});

it("single-flights polling and manual refresh without restarting on snapshot object churn", async () => {
  const f = clientFixture();
  const input = options(f.client);
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  await advance(2000);
  rerender({ ...input, jobs: [{ ...running }] });
  f.holdLists();
  await advance(2000);
  expect(f.command).toHaveBeenCalledTimes(2);
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => { first = result.current.refresh(); second = result.current.refresh(); });
  expect(first).toBe(second);
  await advance(16000);
  expect(f.command).toHaveBeenCalledTimes(2);
  await act(async () => { f.listResult(f.latest("services.list"), [web]); await first; });
  expect(result.current.servicesState).toBe("ready");
});

it("stops all reads while hidden and fences late receipts across visibility changes", async () => {
  const f = clientFixture();
  f.holdLists();
  const doc = visibility();
  const input = options(f.client, { document: doc.document });
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  const initial = f.latest("services.list");
  rerender({ ...input, active: false });
  await advance(12000);
  await act(async () => { f.listResult(initial, [{ ...web, name: "hidden-old" }]); await result.current.refresh(); });
  expect(f.command).toHaveBeenCalledTimes(1);
  expect(result.current.rows.every((row) => row.kind === "job")).toBe(true);
  rerender(input);
  await flush();
  const beforeHidden = f.latest("services.list");
  act(() => { doc.setHidden(true); });
  await advance(12000);
  expect(f.command).toHaveBeenCalledTimes(2);
  act(() => { doc.setHidden(false); });
  await flush();
  expect(f.command).toHaveBeenCalledTimes(3);
  await act(async () => { f.listResult(f.latest("services.list"), [{ ...web, name: "current" }]); });
  await act(async () => { f.listResult(beforeHidden, [{ ...web, name: "late" }]); });
  expect(result.current.rows.filter((row) => row.kind === "service").map((row) => row.label)).toEqual(["current"]);
});

it("isolates scope/client changes and disconnection from old reads and stop receipts", async () => {
  const f = clientFixture();
  const remote = clientFixture();
  f.holdLists(); remote.holdLists();
  const input = options(f.client);
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  const oldRead = f.latest("services.list");
  let cancel!: Promise<void>;
  act(() => { cancel = result.current.stop(result.current.rows[0]!); });
  const oldCancel = f.latest("job.cancel");
  rerender({ ...input, client: remote.client, scopeKey: "remote/workspace", sessionId: "other" });
  await flush();
  expect(result.current.pending.size).toBe(0);
  await act(async () => {
    f.listResult(oldRead, [{ ...web, name: "old-local" }]);
    f.fail(oldCancel, "Old session closed");
    await cancel;
  });
  expect(result.current.actionErrors.size).toBe(0);
  expect(result.current.rows.every((row) => row.kind === "job")).toBe(true);
  const disconnectedRead = remote.latest("services.list");
  const disconnected = { ...input, client: remote.client, scopeKey: "remote/workspace", sessionId: "other", available: false };
  rerender(disconnected);
  await act(async () => { remote.listResult(disconnectedRead, [{ ...web, name: "disconnected" }]); });
  await advance(8000);
  expect(result.current.servicesState).toBe("unavailable");
  expect(result.current.rows.every((row) => row.kind === "job")).toBe(true);
  expect(remote.command).toHaveBeenCalledTimes(1);
  rerender({ ...disconnected, available: true });
  await flush();
  await act(async () => { remote.listResult(remote.latest("services.list"), [{ ...web, ownerId: "other" }]); });
  expect(result.current.rows.filter((row) => row.kind === "service")).toHaveLength(1);
});

it("sends exact job generation and service instance, sharing pending until real terminal truth", async () => {
  const f = clientFixture();
  const input = options(f.client);
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  const job = result.current.rows.find((row) => row.kind === "job")!;
  const service = result.current.rows.find((row) => row.kind === "service")!;
  let cancel!: Promise<void>;
  let stop!: Promise<void>;
  act(() => {
    cancel = result.current.stop(job);
    stop = result.current.stop(service);
    void result.current.stop(job);
    void result.current.stop(service);
  });
  expect(f.sent.filter((item) => item.kind === "job.cancel")).toHaveLength(1);
  expect(f.latest("job.cancel").payload).toEqual({ jobId: "shared", expectedGeneration: 7 });
  expect(f.sent.filter((item) => item.kind === "services.stop")).toHaveLength(1);
  expect(f.latest("services.stop").payload).toEqual({ name: "shared", instanceId: "web-instance-2" });
  expect(result.current.pending).toEqual(new Set([job.key, service.key]));
  await act(async () => {
    f.complete(f.latest("job.cancel"), { status: "cancellation_requested" });
    f.complete(f.latest("services.stop"), { result: { service: { ...web, state: "stopping" } } });
    await Promise.all([cancel, stop]);
  });
  expect(result.current.rows.find((row) => row.key === job.key)?.state).toBe("running");
  expect(result.current.rows.find((row) => row.key === service.key)?.state).toBe("stopping");
  expect(result.current.pending).toEqual(new Set([job.key, service.key]));
  expect(result.current.canStop(job)).toBe(false);
  rerender({ ...input, jobs: [{ ...running, status: "cancelled", completedAt: new Date(startedAt + 55000).toISOString() }] });
  expect(result.current.pending).toEqual(new Set([service.key]));
  f.setServices([{ ...web, state: "exited", exitedAt: startedAt + 55000, exitCode: 0 }]);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.pending.size).toBe(0);
  expect(result.current.rows.every((row) => !row.active)).toBe(true);
});

it("keeps action failures separate from business state and rejects replaced-run stop targets", async () => {
  const f = clientFixture();
  const input = options(f.client);
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  const oldService = result.current.rows.find((row) => row.kind === "service")!;
  const oldJob = result.current.rows.find((row) => row.kind === "job")!;
  let stop!: Promise<void>;
  act(() => { stop = result.current.stop(oldService); });
  await act(async () => { f.fail(f.latest("services.stop"), "Permission denied"); await stop; });
  expect(result.current.pending.size).toBe(0);
  expect(result.current.actionErrors.get(oldService.key)).toBe("Permission denied");
  expect(result.current.rows.find((row) => row.key === oldService.key)?.state).toBe("ready");
  expect(result.current.servicesState).toBe("ready");
  expect(result.current.canStop(oldService)).toBe(true);
  f.setServices([{ ...web, instanceId: "replacement" }]);
  await act(async () => { await result.current.refresh(); });
  rerender({ ...input, jobs: [{ ...running, generation: 8 as StudioJobSnapshot["generation"] }] });
  const sentBefore = f.sent.length;
  await act(async () => { await result.current.stop(oldJob); await result.current.stop(oldService); });
  expect(f.sent).toHaveLength(sentBefore);
  expect(result.current.actionErrors.size).toBe(0);
});

it("reports unavailable sources honestly and honors independent control capabilities", async () => {
  const f = clientFixture();
  const input = options(f.client, { canListServices: false, canCancelJobs: false, jobsReady: false });
  const { result, rerender } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  await act(async () => { await result.current.refresh(); });
  expect(result.current.servicesState).toBe("unavailable");
  expect(result.current.jobsReady).toBe(false);
  expect(result.current.rows).toEqual([]);
  expect(f.command).not.toHaveBeenCalled();
  rerender({ ...input, jobsReady: true });
  expect(result.current.rows).toHaveLength(1);
  expect(result.current.canStop(result.current.rows[0]!)).toBe(false);
  rerender({ ...input, jobsReady: true, canCancelJobs: true, canListServices: true, canStopServices: false });
  await flush();
  expect(result.current.canStop(result.current.rows.find((row) => row.kind === "job")!)).toBe(true);
  expect(result.current.canStop(result.current.rows.find((row) => row.kind === "service")!)).toBe(false);
});

it("filters delegated work out of the shared source, including child-owned services", async () => {
  const childId = "child" as StudioJobSnapshot["ownerAgentId"];
  const childService = { ...web, name: "child-dev", instanceId: "child-dev", ownerId: "child-session", ownerAgentId: childId };
  const f = clientFixture([web, childService]);
  const input = options(f.client, { jobs: [running,
    { ...running, jobId: "delegation" as StudioJobSnapshot["jobId"], type: "task", agentId: childId },
    { ...running, jobId: "child-shell" as StudioJobSnapshot["jobId"], ownerAgentId: childId },
  ] });
  const { result } = renderHook(useBackgroundTasks, { initialProps: input });
  await flush();
  expect(result.current.rows.map(row => row.label)).toEqual([running.label, web.name]);
  expect(result.current.rows.filter(row => row.kind === "job")).toHaveLength(1);
  expect(result.current.rows.filter(row => row.kind === "service")).toHaveLength(1);
});
