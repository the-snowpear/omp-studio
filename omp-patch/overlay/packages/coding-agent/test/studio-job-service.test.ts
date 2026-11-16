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
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { GhRunWatchViewDetails } from "@oh-my-pi/pi-tui/tools/github";
import { buildRunWatchRunDetails } from "../src/tools/gh-run-watch";
import { callSessionTool, type JsStatusEvent } from "../src/eval/js/tool-bridge";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import type { AgentSession } from "../src/session/agent-session";
import { inspectStudioJob } from "../src/studio/services/job-inspect";
import { projectActionsWatch } from "../src/studio/services/job-actions";

function nativeWatch(): GhRunWatchViewDetails {
	return {
		mode: "run",
		state: "completed",
		repo: "owner/project",
		run: buildRunWatchRunDetails(
			{
				id: 41,
				workflowName: "Checks",
				status: "in_progress",
				jobs: [
					{
						id: 42,
						name: "renderer",
						status: "completed",
						conclusion: "failure",
						startedAt: "2026-11-12T11:59:00.000Z",
						completedAt: "2026-11-12T12:00:05.000Z",
						steps: [
							{ number: 3, name: "Upload", status: "pending" },
							{
								number: 2,
								name: "Check types",
								status: "completed",
								conclusion: "failure",
								startedAt: "2026-11-12T12:00:01.000Z",
								completedAt: "2026-11-12T12:00:04.000Z",
							},
							{
								number: 1,
								name: "Cache",
								status: "completed",
								conclusion: "success",
								startedAt: "2026-11-12T12:00:00.000Z",
								completedAt: "2026-11-12T12:00:00.000Z",
							},
						],
					},
					{ id: 43, name: "queued job", status: "queued", steps: [] },
				],
			},
			Date.parse("2026-11-12T12:00:05.000Z"),
		),
		failedLogs: [
			{
				runId: 41,
				jobName: "renderer",
				available: true,
				tail: "old output\n".repeat(2000) + "\u001b[31mNative step failed\u001b[0m",
			},
		],
	};
}

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

describe("native Actions on existing jobs", () => {
	test("inspects only the task's own watch, preserving native times and bounded failed logs", async () => {
		const h = fixture();
		const watch = nativeWatch();
		const candidate = job("parent-task", {
			latestDetails: {
				progress: [
					{ id: "Sibling", actions: { ...watch, repo: "other/project" }, stage: "other task" },
					{ id: "Worker", actions: watch, stage: "native watch" },
				],
			},
		});
		h.jobs.set(candidate.id, candidate);
		const row = h.service.get(candidate.id);
		expect(row.actions?.repo).toBe("owner/project");
		expect(row.stage).toBe("native watch");
		expect(row.type).toBe("task");
		expect(row.actions?.failedLogs).toBeUndefined();
		const steps = row.actions!.runs[0]!.jobs[0]!.steps;
		expect(steps.map(step => step.number)).toEqual([1, 2, 3]);
		expect(steps.map(step => step.durationSeconds)).toEqual([0, 3, undefined]);
		expect(row.actions!.runs[0]!.jobs[0]!.durationSeconds).toBe(65);
		expect(row.actions!.runs[0]!.jobs[1]!.durationSeconds).toBeUndefined();
		expect(row.completionPercent).toBeUndefined();

		const session = {
			inspectAsyncJob: () => ({ pids: [], output: "original process output" }),
			asyncJobManager: { getJob: (id: string) => h.jobs.get(id) },
		} as unknown as AgentSession;
		const inspected = await inspectStudioJob(session, candidate.id);
		expect(inspected.output).toBe("original process output");
		const log = inspected.actions?.failedLogs?.[0];
		expect(log?.jobId).toBe(42);
		expect(log?.tail?.endsWith("Native step failed")).toBe(true);
		expect(log?.tail).not.toContain("\u001b");
		expect(Buffer.byteLength(log?.tail ?? "")).toBeLessThanOrEqual(16 * 1024);
		expect(inspected.actions?.truncated).toBe(true);
		candidate.status = "completed";
		candidate.latestDetails = {
			progress: [{ id: "Worker", actions: { ...watch, state: "watching" }, stage: "native watch" }],
			results: [{ id: "Worker", actions: watch }],
		};
		const settled = h.service.get(candidate.id);
		expect(settled.stage).toBe("native watch");
		expect(settled.actions?.state).toBe("completed");
	});

	test("does not borrow an unmatched batch member or turn a bash result into a GitHub job", () => {
		const h = fixture();
		const watch = nativeWatch();
		h.jobs.set(
			"unmatched",
			job("unmatched", {
				latestDetails: {
					progress: [
						{ id: "Other", actions: watch, stage: "other task" },
						{ id: "Sibling", actions: watch },
					],
				},
			}),
		);
		expect(h.service.get("unmatched").actions).toBeUndefined();
		expect(h.service.get("unmatched").stage).toBeUndefined();
		h.jobs.set(
			"eval-parent",
			job("eval-parent", { type: "eval", agentId: undefined, latestDetails: { actions: watch } }),
		);
		expect(h.service.get("eval-parent").type).toBe("eval");
		expect(h.service.get("eval-parent").actions?.state).toBe("completed");
		h.jobs.set(
			"bash-parent",
			job("bash-parent", { type: "bash", agentId: undefined, latestDetails: { actions: watch } }),
		);
		expect(h.service.get("bash-parent").actions).toBeUndefined();
	});

	test("keeps failure-log identities even when the workflow/step display budget omits their run", () => {
		const base = nativeWatch();
		const { run, ...rest } = base;
		if (!run) throw new Error("Native fixture has no run");
		const runs = Array.from({ length: 9 }, (_, index) => ({
			...run,
			id: index + 1,
			jobs: Array.from({ length: 20 }, (_, jobIndex) => ({
				...run.jobs[0]!,
				id: index * 100 + jobIndex,
				name: `job-${jobIndex}`,
				steps: Array.from({ length: 100 }, (_, number) => ({
					number: number + 1,
					name: `step-${number + 1}`,
					status: "pending",
				})),
			})),
		}));
		const shown = projectActionsWatch(
			{
				...rest,
				runs,
				failedLogs: [{ runId: 9, jobName: "job-0", available: true, tail: "last omitted run failed" }],
			},
			true,
		)!;
		expect(shown.runs).toHaveLength(8);
		expect(shown.runs.flatMap(value => value.jobs).length).toBeLessThanOrEqual(24);
		expect(shown.runs.flatMap(value => value.jobs.flatMap(value => value.steps)).length).toBeLessThanOrEqual(96);
		expect(shown.truncated).toBe(true);
		expect(shown.failedLogs?.[0]).toMatchObject({ runId: 9, jobId: 800, tail: "last omitted run failed" });
	});

	test("the eval bridge publishes original watch frames and ignores updates after its foreground call settled", async () => {
		const started = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<AgentToolResult>();
		let update: AgentToolUpdateCallback | undefined;
		const initial = { ...nativeWatch(), state: "watching" as const };
		const execute: AgentTool["execute"] = async (_id, _args, _signal, onUpdate) => {
			update = onUpdate;
			onUpdate?.({ content: [], details: { watch: initial } });
			started.resolve();
			return finished.promise;
		};
		const tool = {
			name: "github",
			label: "GitHub",
			description: "Native watch fixture",
			concurrency: "parallel",
			parameters: type({ op: "string" }),
			execute,
		} as unknown as AgentTool;
		const session: ToolSession = {
			cwd: "/isolated",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
			getToolByName: name => (name === "github" ? tool : undefined),
		};
		const events: JsStatusEvent[] = [];
		const call = callSessionTool("github", { op: "run_watch" }, { session, emitStatus: event => events.push(event) });
		await started.promise;
		expect(events.filter(event => event.op === "github_watch")).toHaveLength(1);
		finished.resolve({
			content: [{ type: "text", text: "native failure" }],
			details: { watch: nativeWatch() },
			isError: true,
		});
		await call;
		const frames = events.filter(event => event.op === "github_watch");
		const h = fixture();
		h.jobs.set("eval-job", job("eval-job", { type: "eval", latestDetails: { actions: frames.at(-1)?.watch } }));
		expect(h.service.get("eval-job").actions?.state).toBe("completed");
		update?.({ content: [], details: { watch: initial } });
		expect(events.filter(event => event.op === "github_watch")).toHaveLength(2);
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
