import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	StudioJobError,
	StudioJobService,
	type StudioJobsPort,
	type StudioJobConfirmationGate,
} from "@oh-my-pi/pi-coding-agent/studio/services/job-service";

import { JobWidgets } from "../src/job-widgets/registry";
import { TextTap } from "../src/job-widgets/text-tap";

const SECRET = "D:/secret/jobs/private.jsonl";

function job(id: string, overrides: Partial<AsyncJob> = {}): AsyncJob {
	return {
		id,
		type: "task",
		status: "running",
		startTime: 1_700_000_000_000,
		label: `job ${id}`,
		abortController: new AbortController(),
		promise: Promise.resolve(),
		ownerId: "Main",
		agentId: "Worker",
		...overrides,
	};
}

function fixture(options: { confirm?: boolean; confirmationGate?: StudioJobConfirmationGate } = {}) {
	const jobs = new Map<string, AsyncJob>();
	const cancelled: string[] = [];
	const abortedAgents: string[] = [];
	const port: StudioJobsPort = {
		getJob: id => jobs.get(id),
		getRunningJobs: () => [...jobs.values()].filter(candidate => candidate.status === "running"),
		getRecentJobs: limit =>
			[...jobs.values()]
				.filter(candidate => candidate.status !== "running")
				.sort((a, b) => b.startTime - a.startTime)
				.slice(0, limit),
		getAllJobs: () => [...jobs.values()],
		cancel: (id, filter) => {
			const candidate = jobs.get(id);
			if (candidate?.status !== "running" || (filter?.ownerId && candidate.ownerId !== filter.ownerId)) {
				return false;
			}
			candidate.status = "cancelled";
			cancelled.push(id);
			return true;
		},
	};
	const registry = new Map([
		["Main", { id: "Main" }],
		["Worker", { id: "Worker", parentId: "Main" }],
		["Sibling", { id: "Sibling", parentId: "Main" }],
	]);
	const service = new StudioJobService(
		port,
		{ get: id => registry.get(id) },
		{
			confirmationGate: options.confirmationGate ?? (async () => options.confirm ?? true),
			abortAgent: {
				abortAgent: async id => {
					abortedAgents.push(id);
				},
			},
			summaryLimit: 32,
		},
	);
	return { service, jobs, cancelled, abortedAgents, port };
}

describe("StudioJobService job tree and widgets", () => {
	test("lists only observed widgets without authoring until an inspector shows the job", async () => {
		let authored = 0;
		const widgets = new JobWidgets({
			now: () => 1_700_000_020_000,
			authorAfterMs: 0,
			author: async () => {
				authored += 1;
				return { skip: "No chart is needed" };
			},
		});
		const tap = new TextTap("out", "stdout");
		tap.append("step 1\nstep 2\nstep 3\n");
		const candidate = job("observed", {
			type: "bash",
			agentId: undefined,
			widgetInputs: { sources: () => [tap], brief: () => ({ kind: "bash", command: "run-long-task" }) },
		});
		const h = fixture();
		h.jobs.set(candidate.id, candidate);
		h.port.widgetView = value => widgets.peek(value);
		try {
			expect(h.service.list({ callerAgentId: "Main" })[0]?.widget).toBeUndefined();
			await Promise.resolve();
			expect(authored).toBe(0);
			widgets.view(candidate);
			await Promise.resolve();
			expect(authored).toBe(1);
			expect(h.service.list({ callerAgentId: "Main" })[0]?.widget).toBeDefined();
			expect(authored).toBe(1);
		} finally {
			widgets.dispose();
		}
	});

	test("keeps a settled job's last widget and frozen end, and links owners up to the root", () => {
		const jobs = new Map<string, AsyncJob>();
		const views: string[] = [];
		const port: StudioJobsPort = {
			getJob: id => jobs.get(id),
			getRunningJobs: () => [...jobs.values()].filter(candidate => candidate.status === "running"),
			getRecentJobs: () => [...jobs.values()].filter(candidate => candidate.status !== "running"),
			getAllJobs: () => [...jobs.values()],
			cancel: () => false,
			widgetView: candidate => {
				views.push(candidate.id);
				return {
					title: `watch ${candidate.id}`,
					blocks: [{ kind: "text", text: "ok" }],
					state: "live",
					updatedAt: 1,
				};
			},
		};
		// "Gone" left the registry; its task job (owned by Worker) still links it.
		const registry = new Map([
			["Main", { id: "Main" }],
			["Worker", { id: "Worker", parentId: "Main" }],
		]);
		const service = new StudioJobService(port, { get: id => registry.get(id) });
		jobs.set("task-gone", job("task-gone", { ownerId: "Worker", agentId: "Gone" }));
		jobs.set(
			"bash-1",
			job("bash-1", {
				type: "bash",
				ownerId: "Gone",
				agentId: undefined,
				process: { command: "cargo test --workspace", cwd: "/repo", pids: () => [42] },
			}),
		);
		const running = service.list({ callerAgentId: "Main" }).find(row => row.jobId === "bash-1");
		expect(running?.widget?.title).toBe("watch bash-1");
		expect(running?.command).toBe("cargo test --workspace");

		const bash = jobs.get("bash-1")!;
		bash.status = "completed";
		bash.endTime = bash.startTime + 5_000;
		views.length = 0;
		const settled = service.get("bash-1");
		expect(views).toEqual([]); // no widget authoring for a settled job
		expect(settled.widget?.title).toBe("watch bash-1");
		expect(Date.parse(settled.completedAt!) - Date.parse(settled.startedAt)).toBe(5_000);

		const links = service.agentLinks(service.list({ callerAgentId: "Main", includeRecent: true }), "Main");
		expect(links).toEqual(
			expect.arrayContaining([
				{ id: "Gone", parentId: "Worker" },
				{ id: "Worker", parentId: "Main" },
			]),
		);
		expect(links.some(link => link.id === "Main")).toBe(false);
	});

	test("reports a running task's stage and completion estimate from its progress", () => {
		const h = fixture();
		h.jobs.set(
			"task-1",
			job("task-1", {
				latestDetails: { progress: [{ id: "task-1", stage: " wiring the parser ", completionPercent: 140 }] },
			}),
		);
		const row = h.service.get("task-1");
		expect(row.stage).toBe("wiring the parser");
		expect(row.completionPercent).toBe(100);
		h.jobs.get("task-1")!.status = "completed";
		expect(h.service.get("task-1").completionPercent).toBeUndefined();
	});
});

describe("WP-054 StudioJobService", () => {
	test("keeps running and queued jobs visible when newer settled jobs fill the list", () => {
		const h = fixture();
		h.jobs.set("old-shell", job("old-shell", { type: "bash", agentId: undefined }));
		h.jobs.set("old-queued", job("old-queued", { type: "bash", agentId: undefined, queued: true }));
		for (let index = 0; index < 100; index++) {
			const id = `finished-${index}`;
			h.jobs.set(id, job(id, { status: "completed", startTime: 1_700_000_000_001 + index }));
		}
		const rows = h.service.list({ callerAgentId: "Main", includeRecent: true });
		expect(rows.slice(0, 2).map(row => row.jobId)).toEqual(["old-shell", "old-queued"]);
		expect(rows.find(row => row.jobId === "old-queued")?.status).toBe("queued");
		expect(rows.some(row => row.status === "completed")).toBe(true);
		expect(rows).toHaveLength(100);
	});

	test("does not cancel a replacement registered while confirmation is pending", async () => {
		const approval = Promise.withResolvers<boolean>();
		const h = fixture({ confirmationGate: () => approval.promise });
		const original = job("reused", { type: "bash", agentId: undefined });
		h.jobs.set(original.id, original);
		const cancellation = h.service.cancel({ jobId: original.id, expectedGeneration: 1, callerAgentId: "Main" });
		const outcome = cancellation.then(
			() => undefined,
			cause => cause,
		);
		const replacement = job(original.id, { type: "bash", agentId: undefined, startTime: original.startTime + 1 });
		h.jobs.set(original.id, replacement);
		approval.resolve(true);
		expect(await outcome).toMatchObject({ code: "JOB_GENERATION_CONFLICT" });
		expect(replacement.status).toBe("running");
		expect(h.cancelled).toEqual([]);
		expect(h.abortedAgents).toEqual([]);
	});

	test("lists bounded owner-scoped DTOs without native handles", () => {
		const h = fixture();
		h.jobs.set("running", job("running", { label: SECRET }));
		h.jobs.set("done", job("done", { status: "completed", resultText: "x".repeat(100), startTime: 2 }));
		const rows = h.service.list({ callerAgentId: "Main", includeRecent: true });
		expect(rows).toHaveLength(2);
		expect(rows.find(row => row.jobId === "done")?.summary?.length).toBeLessThanOrEqual(33);
		expect(JSON.stringify(rows)).not.toContain("abortController");
		expect(JSON.stringify(rows)).not.toContain("promise");
	});

	test("cancels with generation CAS, owner filter, confirmation, and agent cleanup", async () => {
		const h = fixture();
		h.jobs.set("j1", job("j1"));
		const snapshot = h.service.get("j1");
		const result = await h.service.cancel({
			jobId: "j1",
			expectedGeneration: snapshot.generation,
			callerAgentId: "Main",
		});
		expect(result).toMatchObject({ outcome: "cancelled", snapshot: { status: "cancelled" } });
		expect(h.cancelled).toEqual(["j1"]);
		expect(h.abortedAgents).toEqual(["Worker"]);
	});

	test("rejects stale generations and cross-owner cancellation", async () => {
		const h = fixture();
		h.jobs.set("j1", job("j1"));
		h.service.get("j1");
		h.jobs.set("j1", job("j1", { startTime: 1_700_000_000_001 }));
		await expect(
			h.service.cancel({ jobId: "j1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "JOB_GENERATION_CONFLICT",
		});
		h.jobs.set("sibling", job("sibling", { ownerId: "Sibling" }));
		await expect(
			h.service.cancel({ jobId: "sibling", expectedGeneration: 1, callerAgentId: "Worker" }),
		).rejects.toMatchObject({ code: "NOT_OWNER" });
	});

	test("terminal cancellation is idempotent and denied confirmation makes no mutation", async () => {
		const terminal = fixture();
		terminal.jobs.set("done", job("done", { status: "completed" }));
		expect(
			await terminal.service.cancel({ jobId: "done", expectedGeneration: 1, callerAgentId: "Main" }),
		).toMatchObject({
			outcome: "already_terminal",
		});

		const denied = fixture({ confirm: false });
		denied.jobs.set("j1", job("j1"));
		await expect(
			denied.service.cancel({ jobId: "j1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "CONFIRMATION_DENIED" });
		expect(denied.jobs.get("j1")?.status).toBe("running");
	});

	test("invalid and missing ids fail with typed path-free errors", () => {
		const h = fixture();
		expect(() => h.service.get("")).toThrow(StudioJobError);
		try {
			h.service.get("missing");
		} catch (error) {
			expect(error).toMatchObject({ code: "JOB_NOT_FOUND" });
			expect(String(error)).not.toContain(SECRET);
		}
	});
});
