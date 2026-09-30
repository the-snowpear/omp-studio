import { afterEach, beforeEach, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { getAgentDir, setAgentDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { closeDb, initDb, insertUserMessageStats, getPendingFrustrationTotals } from "@oh-my-pi/omp-stats/db";
import { withStudioStatsFilter } from "@oh-my-pi/omp-stats/rollup";
import { type StatsJudge } from "@oh-my-pi/omp-stats/frustration";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { tokenUsage, type JudgmentResult, type JudgmentRequest, type Questions } from "@oh-my-pi/pi-ai";
import type { UserMessageStats } from "@oh-my-pi/omp-stats/types";
import { StudioStatsService } from "../src/studio/stats-worker";
import { validateStatsSnapshot } from "../src/studio/stats-protocol";
const originalAgentDir = getAgentDir();
const keys = ["PI_CONFIG_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "studio-stats-worker-"));
	for (const key of keys) delete process.env[key];
	process.env.PI_CONFIG_DIR = relative(homedir(), root);
	setAgentDir(join(root, "agent"));
});
afterEach(() => {
	closeDb();
	for (const key of keys) {
		if (prior[key] === undefined) delete process.env[key];
		else process.env[key] = prior[key];
	}
	setAgentDir(originalAgentDir);
});
function user(id: string, folder: string): UserMessageStats {
	return {
		sessionFile: "/synthetic/" + id,
		entryId: id,
		folder,
		timestamp: Date.now(),
		model: "one",
		provider: "mock",
		chars: id.length,
		words: 1,
		yelling: 0,
		profanity: 0,
		anguish: 0,
		negation: 0,
		repetition: 0,
		blame: 0,
		prose: id,
		proseHash: Bun.hash(id).toString(16),
	};
}

test("failed-only retry excludes new texts and retains scope after a native circuit-breaker failure", async () => {
	const relativeDb = relative(root, getStatsDbPath());
	expect(relativeDb.startsWith("..")).toBe(false);
	expect(relativeDb.includes(":")).toBe(false);
	await initDb();
	const calls = new Set<string>();
	const service = new StudioStatsService(async () => ({
		close() {},
		judge: {
			label: "failing",
			primaryModel: () => getBundledModel("anthropic", "claude-sonnet-4-5"),
			judge: async request => {
				calls.add(String(request.state));
				throw Error("synthetic Judge failure");
			},
		},
	}));
	const filter = { range: "all" as const, folder: "/retry" };
	try {
		insertUserMessageStats(Array.from({ length: 80 }, (_, i) => user("failure-" + i, "/retry")));
		const estimate = await service.frustration({ action: "estimate", filter });
		expect((await service.frustration({ action: "start", filter, quoteId: estimate.quote!.id })).available).toBe(
			true,
		);
		for (let i = 0; i < 300 && (await service.read(filter)).frustration?.job.state === "running"; i++)
			await Bun.sleep(10);
		const job = (await service.read(filter)).frustration!.job;
		expect(job.state).toBe("failed");
		expect(job.failed).toBeGreaterThan(0);
		expect(calls.size).toBeLessThan(80);
		insertUserMessageStats([user("added-after-analysis", "/retry")]);
		const retry = await service.frustration({ action: "retry", filter });
		expect(retry.available).toBe(true);
		expect(retry.quote!.messages).toBe(job.failed);
		expect(retry.quote!.messages).toBeLessThan(81);
	} finally {
		await service.dispose();
	}
});

test("cancellation reaches Judge, preserves pending work, and prevents restart until requests drain", async () => {
	const relativeDb = relative(root, getStatsDbPath());
	expect(relativeDb.startsWith("..")).toBe(false);
	expect(relativeDb.includes(":")).toBe(false);
	await initDb();
	let aborts = 0;
	let release: () => void = () => {};
	const service = new StudioStatsService(async () => ({
		close() {},
		judge: {
			label: "waiting",
			primaryModel: () => getBundledModel("anthropic", "claude-sonnet-4-5"),
			judge: async (_request, options) =>
				new Promise((_resolve, reject) => {
					release = () => reject(Error("cancelled"));
					options?.signal?.addEventListener(
						"abort",
						() => {
							aborts++;
						},
						{ once: true },
					);
				}),
		},
	}));
	const filter = { range: "all" as const, folder: "/cancel" };
	try {
		insertUserMessageStats([user("pending", "/cancel")]);
		const estimate = await service.frustration({ action: "estimate", filter });
		expect((await service.frustration({ action: "start", filter, quoteId: estimate.quote!.id })).available).toBe(
			true,
		);
		expect((await service.frustration({ action: "cancel", filter })).job?.state).toBe("cancelled");
		expect(aborts).toBe(1);
		expect((await service.frustration({ action: "estimate", filter })).available).toBe(false);
		release();
		await Bun.sleep(10);
		expect((await service.read(filter)).frustration?.overall.judged).toBe(0);
		expect((await service.frustration({ action: "estimate", filter })).quote?.messages).toBe(1);
		expect((await service.frustration({ action: "retry", filter })).available).toBe(false);
	} finally {
		release();
		await service.dispose();
	}
});

test("Frustration reads do not call Judge; confirmation is bound to scope and consumed once", async () => {
	const relativeDb = relative(root, getStatsDbPath());
	expect(relativeDb.startsWith("..")).toBe(false);
	expect(relativeDb.includes(":")).toBe(false);
	await initDb();
	const calls: string[] = [];
	const judge: StatsJudge = {
		label: "test",
		primaryModel: () => getBundledModel("anthropic", "claude-sonnet-4-5"),
		judge: async <Q extends Questions>(request: JudgmentRequest<Q>) => {
			calls.push(String(request.state));
			return {
				api: "typesafe",
				provider: "fake",
				model: "judge",
				answers: {
					annoyed: { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 }, confidence: 1 },
					target: {
						type: "choice",
						choice: "none",
						probabilities: { none: 1, assistant: 0, other: 0 },
						confidence: 1,
					},
				} as JudgmentResult<Q>["answers"],
				usage: tokenUsage(50, 0, 0.001),
			};
		},
	};
	let resolutions = 0;
	const service = new StudioStatsService(async () => {
		resolutions++;
		return { judge, close() {} };
	});
	try {
		insertUserMessageStats([user("first", "/a"), user("second", "/a"), user("outside", "/b")]);
		const filter = { range: "all" as const, folder: "/a" };
		const snapshot = await service.read(filter);
		validateStatsSnapshot(snapshot);
		expect(snapshot.frustration?.overall.messages).toBe(2);
		expect(calls).toHaveLength(0);
		expect(resolutions).toBe(0);
		const stale = await service.frustration({ action: "estimate", filter });
		expect(stale.quote?.messages).toBe(2);
		expect(calls).toHaveLength(0);
		insertUserMessageStats([user("new", "/a")]);
		expect((await service.frustration({ action: "start", filter, quoteId: stale.quote!.id })).available).toBe(false);
		expect(calls).toHaveLength(0);
		const review = await service.frustration({ action: "estimate", filter });
		expect(review.quote?.messages).toBe(3);
		expect((await service.frustration({ action: "start", filter, quoteId: review.quote!.id })).available).toBe(true);
		expect((await service.frustration({ action: "start", filter, quoteId: review.quote!.id })).available).toBe(false);
		for (let i = 0; i < 100 && (await service.read(filter)).frustration?.job.state === "running"; i++)
			await Bun.sleep(10);
		expect(calls.sort()).toEqual(["first", "new", "second"]);
		expect((await service.read(filter)).frustration?.overall.judged).toBe(3);
		expect(resolutions).toBe(3);
		expect(
			withStudioStatsFilter(
				{ folder: "/b", proseHashes: [Bun.hash("outside").toString(16)] },
				() => getPendingFrustrationTotals().messages,
			),
		).toBe(1);
	} finally {
		await service.dispose();
	}
});

test("native CLI worker serves typed private statistics without a session", async () => {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "__omp_worker_studio_stats"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	const reader = child.stdout.getReader();
	let buffer = "";
	const request = async (id: number, op: string, extra: object = {}) => {
		child.stdin.write(JSON.stringify({ id, op, ...extra }) + "\n");
		child.stdin.flush();
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const result = JSON.parse(line);
				if (result.id === id) return result;
			}
			const data = await Promise.race([
				reader.read(),
				Bun.sleep(15000).then(() => {
					throw Error("Statistics worker response timed out");
				}),
			]);
			if (data.done) throw Error("Statistics worker stopped before response");
			buffer += new TextDecoder().decode(data.value);
		}
	};
	try {
		expect((await request(1, "hello")).result).toEqual({ protocol: 1, kind: "studio-stats" });
		const result = await request(2, "read", { filter: { range: "all" } });
		expect(result.ok).toBe(true);
		expect(result.result.overall.requests).toBe(0);
		expect(result.result.frustration.overall.messages).toBe(0);
		expect(result.result.sessionId).toBeUndefined();
	} finally {
		child.stdin.end();
		await Promise.race([child.exited, Bun.sleep(3000).then(() => child.kill())]);
		reader.releaseLock();
	}
});
