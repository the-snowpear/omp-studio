import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	StudioJobError,
	StudioJobService,
	type StudioJobsPort,
} from "@oh-my-pi/pi-coding-agent/studio/services/job-service";

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

function fixture(options: { confirm?: boolean } = {}) {
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
			confirmationGate: async () => options.confirm ?? true,
			abortAgent: {
				abortAgent: async id => {
					abortedAgents.push(id);
				},
			},
			summaryLimit: 32,
		},
	);
	return { service, jobs, cancelled, abortedAgents };
}

describe("WP-054 StudioJobService", () => {
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
