import { expect, it } from "vitest";
import type { StudioJobAgentLink, StudioJobSnapshot, StudioServiceRow } from "@omp-studio/studio-protocol";
import { backgroundTaskCounts, buildBackgroundTasks, mainConversationJobs, mainConversationServices, taskDuration, taskStatusLabel } from "./backgroundTasksModel";

const start = Date.parse("2026-11-09T10:00:00Z");
function job(id: string, status: StudioJobSnapshot["status"] = "running", patch: Partial<StudioJobSnapshot> = {}): StudioJobSnapshot {
  return {
    jobId: id as StudioJobSnapshot["jobId"],
    generation: 1 as StudioJobSnapshot["generation"],
    ownerAgentId: "main" as StudioJobSnapshot["ownerAgentId"],
    type: "bash", label: id, status, startedAt: new Date(start).toISOString(), ...patch,
  };
}
function service(name: string, state: StudioServiceRow["state"] = "ready", patch: Partial<StudioServiceRow> = {}): StudioServiceRow {
  return { name, instanceId: name, state, startedAt: start, restartCount: 0, outputBytes: 100, mode: "session", ...patch };
}

it("keeps mixed-source and replaced-run identities distinct without changing source snapshots", () => {
  const jobs = [job("shared"), job("shared", "running", { generation: 2 as StudioJobSnapshot["generation"] })];
  const services = [service("shared"), service("shared", "starting", { instanceId: "replacement" })];
  const rows = buildBackgroundTasks(jobs, services);
  expect(new Set(rows.map((row) => row.key)).size).toBe(4);
  expect(rows[0]!.key).toMatch(/^job:/);
  expect(rows[2]!.key).toMatch(/^service:/);
  expect(rows[0]!.job).toBe(jobs[0]);
  expect(rows[2]!.service).toBe(services[0]);
  expect(rows.map((row) => row.label)).toEqual(["shared", "shared", "shared", "shared"]);
});

it("keeps active trees stable and sorts all settled sources by actual end time", () => {
  const parent = job("parent", "running", { agentId: "agent-parent" as StudioJobSnapshot["ownerAgentId"] });
  const child = job("child", "queued", { ownerAgentId: "agent-descendant" as StudioJobSnapshot["ownerAgentId"] });
  const links: StudioJobAgentLink[] = [{ id: "agent-descendant" as StudioJobAgentLink["id"], parentId: "agent-parent" as StudioJobAgentLink["id"] }];
  const rows = buildBackgroundTasks([
    job("old", "completed", { completedAt: new Date(start + 1000).toISOString() }),
    parent, child,
    job("recent", "failed", { completedAt: new Date(start + 4000).toISOString() }),
  ], [service("web"), service("stopped", "exited", { exitedAt: start + 3000 })], links);
  expect(rows.map((row) => row.label)).toEqual(["parent", "child", "web", "recent", "stopped", "old"]);
  expect(rows.slice(0, 3).map((row) => row.depth)).toEqual([0, 1, 0]);
});

it("counts queued/starting/stopping as active and never calls an exited service cancelled", () => {
  const rows = buildBackgroundTasks([
    job("running"), job("queued", "queued"), job("completed", "completed"),
    job("failed", "failed"), job("cancelled", "cancelled"),
  ], [
    service("starting", "starting"), service("ready"), service("stopping", "stopping"),
    service("exited", "exited", { exitCode: 0 }), service("failed", "failed"),
    service("bad-exit", "exited", { exitCode: 2 }),
  ]);
  expect(backgroundTaskCounts(rows)).toEqual({ active: 5, failed: 3, completed: 2, cancelled: 1, total: 11 });
  expect(taskStatusLabel(rows.find((row) => row.label === "bad-exit")!, false)).toBe("Failed");
  expect(taskStatusLabel(rows.find((row) => row.label === "ready")!, true)).toBe("就绪");
});

it("advances live durations but freezes terminal durations and keeps missing times unknown", () => {
  const rows = buildBackgroundTasks([
    job("live"),
    job("done", "completed", { completedAt: new Date(start + 192000).toISOString() }),
    job("unknown-end", "completed"),
    job("unknown-start", "running", { startedAt: "not a timestamp" }),
  ], [service("exited", "exited", { exitedAt: start + 55000 })]);
  const get = (label: string) => rows.find((row) => row.label === label)!;
  expect(taskDuration(get("live"), start + 55000)).toBe("55s");
  expect(taskDuration(get("live"), start + 192000)).toBe("3m 12s");
  expect(taskDuration(get("done"), start + 400000)).toBe("3m 12s");
  expect(taskDuration(get("done"), start + 800000)).toBe("3m 12s");
  expect(taskDuration(get("exited"), start + 800000)).toBe("55s");
  expect(taskDuration(get("unknown-end"), start + 800000)).toBe("—");
  expect(taskDuration(get("unknown-start"), start + 800000)).toBe("—");
});

it("shows only main-conversation commands, never delegated agents or their descendants", () => {
  const root = job("own-command");
  const delegation = job("launch-agent", "running", { type: "task", agentId: "child" as StudioJobSnapshot["ownerAgentId"] });
  const child = job("child-shell", "running", { ownerAgentId: "child" as StudioJobSnapshot["ownerAgentId"] });
  const nested = job("nested-shell", "completed", { ownerAgentId: "grandchild" as StudioJobSnapshot["ownerAgentId"] });
  expect(mainConversationJobs([root, delegation, child, nested], "main")).toEqual([root]);
  expect(mainConversationJobs([root, child], undefined)).toEqual([]);
  expect(mainConversationJobs([root], "other-main")).toEqual([]);
});
it("excludes child-owned and unowned services while keeping main-owned services", () => {
  const shared = service("web-dev");
  const own = service("main-dev", "ready", { ownerAgentId: "main" as StudioJobSnapshot["ownerAgentId"] });
  const child = service("child-dev", "ready", { ownerAgentId: "child" as StudioJobSnapshot["ownerAgentId"] });
  expect(mainConversationServices([shared, own, child], "main")).toEqual([own]);
  expect(mainConversationServices([own, child], undefined)).toEqual([]);
});

it("recognizes native session-owned Agent services without confusing another session", () => {
  const own = service("dev", "ready", { ownerId: "main-session", previewUrl: "http://localhost:5173/", pid: 200 });
  const other = service("other-dev", "ready", { ownerId: "child-session" });
  expect(mainConversationServices([own, other, service("unowned")], "main-agent", "main-session")).toEqual([own]);
  expect(mainConversationServices([own], "main-agent", "different-session")).toEqual([]);
});
