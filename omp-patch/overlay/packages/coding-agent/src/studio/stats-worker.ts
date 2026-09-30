import { createInterface } from "node:readline";
import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { initDb, closeDb, getPendingFrustrationProse } from "@oh-my-pi/omp-stats/db";
import { syncAllSessions, getTimeRangeConfig, withStatsSyncLock } from "@oh-my-pi/omp-stats/aggregator";
import {
	setStatsJudgeProvider,
	estimateFrustrationRun,
	getFrustrationDashboardStats,
	getFrustrationJobStatus,
	startFrustrationRun,
	cancelFrustrationRun,
	type StatsJudge,
} from "@oh-my-pi/omp-stats/frustration";
import {
	getOverallStats,
	getStatsByModel,
	getStatsByFolder,
	getStatsByProvider,
	getToolStats,
	getSessionRollups,
	refreshRollups,
	withStudioStatsFilter,
} from "@oh-my-pi/omp-stats/rollup";
import type { AggregatedStats } from "@oh-my-pi/omp-stats/types";
import {
	type StatsFilter,
	type StatsRow,
	type StatsSnapshot,
	type FrustrationInput,
	type FrustrationResult,
	type FrustrationJob,
	validateStatsFilter,
	validateFrustrationInput,
} from "./stats-protocol";
function job(): FrustrationJob {
	const { state, total, done, failed, cost, judge } = getFrustrationJobStatus();
	return { state, total, done, failed, cost, judge };
}

function row(id: string, label: string, value: AggregatedStats): StatsRow {
	return {
		id,
		label,
		requests: value.totalRequests,
		errors: value.failedRequests,
		tokens:
			value.totalInputTokens + value.totalOutputTokens + value.totalCacheReadTokens + value.totalCacheWriteTokens,
		costEstimate: value.totalRequests > 0 && value.unpricedRequests >= value.totalRequests ? null : value.totalCost,
		unpriced: value.unpricedRequests,
	};
}
/** Dedicated worker; imports native stats only and never creates an AgentSession or HTTP server. */
export class StudioStatsService {
	#judge: { judge: StatsJudge; close(): void } | undefined;
	#quotes = new Map<
		string,
		{ filter: StatsFilter; fingerprint: string; expiresAt: number; judge: string; priced: boolean; hashes?: string[] }
	>();
	#failedHashes: string[] = [];
	#analysisFilter: StatsFilter | undefined;
	#analysisTask: Promise<void> | undefined;
	#priced = false;
	#job(): FrustrationJob {
		const state = job();
		return {
			...state,
			cost: state.state === "idle" || this.#priced ? state.cost : null,
			...(this.#analysisFilter ? { filter: this.#analysisFilter } : {}),
		};
	}
	constructor(
		private readonly judgeFactory = async (): Promise<{ judge: StatsJudge; close(): void }> => {
			const { openStandaloneJudge } = await import("../judgment/standalone");
			return openStandaloneJudge(process.cwd(), "studio_stats_frustration");
		},
	) {
		this.#refreshJudge();
	}
	// Re-resolve settings and credentials only for explicit estimate/start actions, never dashboard reads.
	#refreshJudge(): void {
		this.#judge?.close();
		this.#judge = undefined;
		setStatsJudgeProvider(async () => {
			this.#judge ??= await this.judgeFactory();
			return this.#judge.judge;
		});
	}
	#sync: StatsSnapshot["sync"] = { state: "idle", current: 0, total: 0, processed: 0 };
	#task: Promise<void> | undefined;
	async read(filter: StatsFilter): Promise<StatsSnapshot> {
		validateStatsFilter(filter);
		await initDb();
		const { range, ...dimensions } = filter;
		const cutoff = getTimeRangeConfig(range ?? "all").cutoff;
		return withStudioStatsFilter(dimensions, async () => {
			const frustration = await getFrustrationDashboardStats(range ?? "all");
			return {
				available: true,
				updatedAt: Date.now(),
				cached: false,
				filter,
				sync: { ...this.#sync },
				overall: row("all", "All", getOverallStats(cutoff)),
				frustration: {
					overall: frustration.overall,
					models: frustration.byModel
						.slice(0, 500)
						.map(({ key, label, messages, judged, annoyed, atAssistant, angry }) => ({
							id: key,
							label,
							messages,
							judged,
							annoyed,
							atAssistant,
							angry,
						})),
					job: this.#job(),
				},
				models: getStatsByModel(cutoff)
					.slice(0, 500)
					.map(value => row(value.provider + "/" + value.model, value.provider + "/" + value.model, value)),
				providers: getStatsByProvider(cutoff)
					.slice(0, 500)
					.map(value => ({
						id: value.provider,
						label: value.provider,
						requests: value.totalRequests,
						errors: value.failedRequests,
						tokens: value.totalTokens,
						costEstimate:
							value.totalRequests > 0 && value.unpricedRequests >= value.totalRequests ? null : value.totalCost,
						unpriced: value.unpricedRequests,
					})),
				projects: getStatsByFolder(cutoff, 500).map(value => row(value.folder, value.folder, value)),
				sessions: getSessionRollups(cutoff)
					.sort((a, b) => b.endedAt - a.endedAt)
					.slice(0, 500)
					.map(value => ({
						id: value.sessionFile,
						label: basename(value.sessionFile),
						requests: value.requests,
						errors: null,
						tokens: value.totalTokens,
						costEstimate: value.requests > 0 && value.unpricedRequests >= value.requests ? null : value.costTotal,
						unpriced: value.unpricedRequests,
					})),
				tools: getToolStats(cutoff)
					.slice(0, 500)
					.map(value => ({
						id: value.tool,
						label: value.tool,
						requests: value.calls,
						errors: value.errors,
						tokens: value.totalTokensShare,
						costEstimate: value.unpricedRequestsShare >= value.calls && value.calls > 0 ? null : value.costShare,
						unpriced: value.unpricedRequestsShare,
					})),
			};
		});
	}
	#fingerprint(range: string | undefined): string {
		return createHash("sha256")
			.update(
				getPendingFrustrationProse(getTimeRangeConfig(range ?? "all").cutoff)
					.map(row => row.hash)
					.sort()
					.join("\n"),
			)
			.digest("hex");
	}
	async frustration(input: FrustrationInput): Promise<FrustrationResult> {
		validateFrustrationInput(input);
		const { range, ...dimensions } = input.filter;
		if (input.action === "cancel") {
			cancelFrustrationRun();
			return { available: true, job: this.#job() };
		}
		if (this.#analysisTask || job().state === "running")
			return { available: false, reason: "A Judge analysis is still running or stopping" };
		if (this.#sync.state === "running")
			return {
				available: false,
				reason: "Wait for statistics synchronization before estimating or starting analysis",
			};
		if (input.action === "retry" && !this.#failedHashes.length)
			return { available: false, reason: "No retained failed items to retry" };
		const retryHashes = input.action === "retry" ? [...this.#failedHashes] : undefined;
		if (input.action !== "start")
			return withStatsSyncLock(getStatsDbPath(), () =>
				withStudioStatsFilter({ ...dimensions, ...(retryHashes ? { proseHashes: retryHashes } : {}) }, async () => {
					if (this.#analysisTask)
						return { available: false, reason: "A Judge analysis is still running or stopping" };
					this.#refreshJudge();
					const estimate = await estimateFrustrationRun(range ?? "all");
					if (!estimate.available)
						return { available: false, reason: "Configure an available Judge model to analyze frustration" };
					const id = randomUUID();
					const expiresAt = Date.now() + 300000;
					if (this.#quotes.size >= 10) this.#quotes.clear();
					this.#quotes.set(id, {
						filter: structuredClone(input.filter),
						fingerprint: this.#fingerprint(range),
						expiresAt,
						judge: estimate.judge,
						priced: estimate.cost > 0,
						...(retryHashes ? { hashes: retryHashes } : {}),
					});
					return {
						available: true,
						quote: {
							id,
							filter: input.filter,
							messages: estimate.messages,
							cost: estimate.cost > 0 ? estimate.cost : null,
							judge: estimate.judge,
							expiresAt,
						},
					};
				}),
			);
		const quote = this.#quotes.get(input.quoteId!);
		this.#quotes.delete(input.quoteId!);
		if (!quote || quote.expiresAt < Date.now() || JSON.stringify(quote.filter) !== JSON.stringify(input.filter))
			return { available: false, reason: "Review a fresh estimate before starting" };
		return withStatsSyncLock(getStatsDbPath(), () =>
			withStudioStatsFilter({ ...dimensions, ...(quote.hashes ? { proseHashes: quote.hashes } : {}) }, async () => {
				if (this.#analysisTask)
					return { available: false, reason: "A Judge analysis is still running or stopping" };
				if (quote.expiresAt < Date.now())
					return { available: false, reason: "The estimate expired; review a new estimate" };
				if (quote.fingerprint !== this.#fingerprint(range))
					return { available: false, reason: "Analysis scope changed; review a new estimate" };
				this.#refreshJudge();
				const estimate = await estimateFrustrationRun(range ?? "all");
				if (!estimate.available || estimate.judge !== quote.judge)
					return { available: false, reason: "Judge changed; review a new estimate" };
				const result = await startFrustrationRun(range ?? "all");
				if (!result.started) return { available: false, reason: "Judge analysis could not start" };
				this.#analysisFilter = structuredClone(input.filter);
				this.#priced = quote.priced;
				this.#failedHashes = [];
				this.#analysisTask = result.finished
					.then(() => {
						this.#failedHashes = [...result.failedHashes];
					})
					.finally(() => {
						this.#analysisTask = undefined;
					});
				return { available: true, job: this.#job() };
			}),
		);
	}
	async dispose(): Promise<void> {
		cancelFrustrationRun();
		await this.#analysisTask;
		await this.#task;
		this.#judge?.close();
		this.#judge = undefined;
		setStatsJudgeProvider(undefined);
	}
	sync(): void {
		if (this.#task || this.#analysisTask) return;
		this.#sync = { state: "running", current: 0, total: 0, processed: 0 };
		this.#task = syncAllSessions({
			workers: 1,
			onProgress: value => {
				this.#sync = { state: "running", current: value.current, total: value.total, processed: value.processed };
			},
		})
			.then(async () => {
				await refreshRollups();
				this.#sync.state = "completed";
			})
			.catch(() => {
				this.#sync.state = "failed";
				this.#sync.error = "Native statistics synchronization failed";
			})
			.finally(() => {
				this.#task = undefined;
			});
	}
}
export async function startStudioStatsWorker(): Promise<void> {
	const service = new StudioStatsService();
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
	lines.on("line", line => {
		void (async () => {
			let id: unknown;
			try {
				if (line.length > 20000) throw Error("Oversized request");
				const request = JSON.parse(line);
				id = request.id;
				if (!Number.isSafeInteger(id)) throw Error("Invalid ID");
				if (request.op === "hello") {
					send({ id, ok: true, result: { protocol: 1, kind: "studio-stats" } });
					return;
				}
				if (request.op === "sync") {
					service.sync();
					send({ id, ok: true, result: { started: true } });
					return;
				}
				if (request.op === "frustration") {
					send({ id, ok: true, result: await service.frustration(request.input) });
					return;
				}
				if (request.op !== "read") throw Error("Unknown statistics operation");
				send({ id, ok: true, result: await service.read(request.filter) });
			} catch {
				send({ id, ok: false, error: "Statistics request failed" });
			}
		})();
	});
	lines.once("close", () => {
		void service.dispose().finally(() => {
			closeDb();
			process.exit(0);
		});
	});
}
