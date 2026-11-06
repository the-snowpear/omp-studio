import { streamSimple } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import {
	CHALLENGE_MAX_TOKENS,
	metricStats,
	readBoundedUtf8File,
	resolveBenchPlan,
	runBenchCommand,
	type BenchDependencies,
	type BenchCommandArgs,
	type BenchTableRow,
} from "../../cli/bench-cli";
import { resolveBenchTargets, type BenchRuntime } from "../../cli/bench-runtime";
import { initialArray } from "../../if-bench/actions";
import { runIfBench, type IfBenchModelReport } from "../../if-bench/runner";
import {
	getJudgmentBatch,
	runEvalJudgmentBatch,
	type JudgmentBatchStatus,
	type JudgmentBatchItem,
} from "../../eval/judgment-batch-bridge";
import { parseQuestions, parseState } from "../../eval/judgment-bridge";
import type { ToolSession } from "../../tools";
import type {
	EvaluationSpec,
	PerformanceEvaluationSpec,
	EvaluationPlan,
	EvaluationNativeSnapshot,
	EvaluationWorkspaceOperation,
	EvaluationResultRow,
} from "../evaluation-workspace-protocol";
import { EvaluationRatchetRunner } from "./evaluation-ratchet-runner";
import { cfgModelRoles } from "../../config/model-settings";
import { cfgTierOpenai, cfgTierAnthropic, cfgTierGoogle } from "../../session/settings";

interface Task {
	spec: EvaluationSpec;
	title: string;
	view: EvaluationNativeSnapshot;
	rows: EvaluationResultRow[];
	abort: AbortController;
	report: unknown;
	batchId?: string;
	timer?: Timer;
	ratchet?: EvaluationRatchetRunner;
	done?: Promise<void>;
	native?: ToolSession;
}
const positive = (value: number | undefined, fallback: number) => {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("Expected a positive integer");
	return value;
};
export function benchmarkCommand(spec: PerformanceEvaluationSpec): BenchCommandArgs {
	return {
		models: spec.models,
		flags: {
			json: true,
			...(spec.profile === "cache"
				? {
						cache: true,
						cachePairs: spec.runs,
						cacheConcurrency: spec.concurrency,
						cachePrefixBytes: spec.cachePrefixBytes,
						cachePrefixFile: spec.cachePrefixFile,
					}
				: {
						...(spec.profile === "detailed" ? { detailed: true } : { profile: spec.profile }),
						runs: spec.runs,
						par: spec.concurrency,
						prefillBytes: spec.prefillBytes,
					}),
			maxTokens: spec.maxTokens,
			prompt: spec.prompt,
			serviceTier: spec.serviceTier,
		},
	};
}
export function evaluationPlan(spec: EvaluationSpec): EvaluationPlan {
	if (spec.kind === "benchmark") {
		if (!spec.models.length) throw new Error("Select at least one model");
		const plan = resolveBenchPlan(benchmarkCommand(spec));
		return {
			spec,
			requests: plan.runs * spec.models.length,
			upperBound: false,
			phases: plan.cacheMode
				? [
						{
							name: "cold / warm",
							requests: plan.runs,
							concurrency: plan.cacheConcurrency!,
							maxTokens: plan.cacheMaxTokens!,
						},
					]
				: plan.steps.map(step => ({
						name: step.phase ?? spec.profile,
						requests: step.runs,
						concurrency: step.concurrency,
						...(step.kinds.length === 1
							? { maxTokens: plan.maxTokensOverride ?? CHALLENGE_MAX_TOKENS[step.kinds[0]!] }
							: {}),
					})),
			notes: ["Provider retries and failures may also incur charges."],
		};
	}
	if (spec.kind === "instruction") {
		if (!spec.models.length) throw new Error("Select at least one model");
		const length = positive(spec.length, 24);
		initialArray(length);
		const turns = positive(spec.turns, 24),
			concurrency = positive(spec.concurrency, 4);
		positive(spec.nyaMax, 8);
		return {
			spec,
			requests: turns * spec.models.length,
			upperBound: true,
			phases: [{ name: "instruction", requests: turns, concurrency, maxTokens: positive(spec.maxTokens, 32768) }],
			notes: ["Each model stops at its first failed turn. Native refusal retries may add requests."],
		};
	}
	if (spec.kind === "judgment") {
		if (!spec.attachId) {
			if (!spec.items.length) throw new Error("Add at least one item");
			parseQuestions(spec.questions);
			const keys = new Set<string>();
			for (const item of spec.items) {
				parseState(item.state);
				if (keys.has(String(item.key))) throw new Error("Item keys must be unique");
				keys.add(String(item.key));
			}
		}
		return {
			spec,
			requests: null,
			upperBound: true,
			phases: [
				{
					name: "judgment",
					requests: spec.items.length,
					concurrency: Math.min(32, positive(spec.concurrency, 32)),
				},
			],
			notes: ["Native question grouping, judge fallback and retries determine the actual number of requests."],
		};
	}
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(spec.flow))
		throw new Error("Use a lowercase flow name with letters, digits, hyphens or underscores");
	if (
		!spec.assist &&
		(!spec.command || !spec.metric || !spec.cases.length || !spec.harness.length || !spec.change.length)
	)
		throw new Error("Choose inputs, runner, change paths and a target metric");
	return {
		spec,
		requests: null,
		upperBound: true,
		phases: [],
		notes: ["Preparation, pilot runs and iteration may incur model and runner costs."],
	};
}

/** Native execution only. The owning Host saves the results independently of Renderer lifetime. */
export class StudioEvaluationWorkspaceService {
	readonly #tasks = new Map<string, Task>();
	readonly #listeners = new Set<(id: string, revision: number) => void>();
	constructor(
		readonly session: AgentSession,
		readonly dependencies: Pick<BenchDependencies, "streamSimple" | "now" | "random"> = {},
	) {}
	get running(): boolean {
		return [...this.#tasks.values()].some(t => ["preparing", "running", "cancelling"].includes(t.view.state));
	}
	subscribe(listener: (id: string, revision: number) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#changed(id: string, task: Task): void {
		task.view.revision++;
		for (const listener of this.#listeners) listener(id, task.view.revision);
	}
	#runtime(): BenchRuntime {
		return { settings: this.session.settings, modelRegistry: this.session.modelRegistry };
	}
	async execute(op: EvaluationWorkspaceOperation): Promise<unknown> {
		if (op.kind === "evaluation.runtime.plan") {
			const plan = evaluationPlan(op.spec);
			plan.settings =
				op.spec.kind === "judgment"
					? { judgeRole: op.spec.judgeModel ?? cfgModelRoles.get(this.session.settings).judge ?? "native-default" }
					: op.spec.kind === "benchmark"
						? {
								serviceTier: op.spec.serviceTier ?? {
									openai: cfgTierOpenai.get(this.session.settings),
									anthropic: cfgTierAnthropic.get(this.session.settings),
									google: cfgTierGoogle.get(this.session.settings),
								},
							}
						: {};
			if (op.spec.kind === "benchmark" && op.spec.cachePrefixFile && op.spec.cachePrefixContent === undefined) {
				plan.spec = {
					...op.spec,
					cachePrefixContent: await readBoundedUtf8File(op.spec.cachePrefixFile, op.spec.cachePrefixBytes ?? 8192),
				};
			}
			if (op.spec.kind === "benchmark" || op.spec.kind === "instruction") {
				const targets = await resolveBenchTargets(
					op.spec.models,
					this.session.modelRegistry,
					this.session.settings,
					() => {},
				);
				plan.resolvedModels = targets.map(
					t => `${t.model.provider}/${t.model.id}${t.thinking ? `:${t.thinking}` : ""}`,
				);
				plan.spec = { ...plan.spec, models: plan.resolvedModels } as EvaluationSpec;
				plan.requests = plan.phases.reduce((total, phase) => total + phase.requests, 0) * targets.length;
			}
			return plan;
		}
		if (!/^[a-f0-9-]{36}$/.test(op.id)) throw new Error("Invalid evaluation identity");
		if (op.kind === "evaluation.runtime.start") {
			if (this.#tasks.has(op.id)) return this.#tasks.get(op.id)!.view;
			evaluationPlan(op.spec);
			const task: Task = {
				spec: op.spec,
				title: op.title,
				rows: [],
				report: null,
				abort: new AbortController(),
				view: {
					state: op.spec.kind === "ratchet" ? "preparing" : "running",
					completed: 0,
					total: 0,
					failed: 0,
					cost: null,
					metrics: [],
					detail: {},
					revision: 0,
				},
			};
			this.#tasks.set(op.id, task);
			task.done = this.#run(op.id, task);
			return task.view;
		}
		let task = this.#tasks.get(op.id);
		if (!task) {
			const runner = await EvaluationRatchetRunner.restore(this.session, op.id);
			if (!runner) throw new Error("Evaluation is no longer resident; use its saved report");
			task = {
				spec: runner.spec,
				title: runner.spec.flow,
				rows: [],
				report: null,
				abort: new AbortController(),
				ratchet: runner,
				view: {
					state: "ready",
					completed: 0,
					total: 0,
					failed: 0,
					cost: null,
					metrics: [],
					detail: {},
					revision: 0,
				},
			};
			this.#tasks.set(op.id, task);
			await this.#refreshRatchet(op.id, task);
		}
		if (task.ratchet) await this.#refreshRatchet(op.id, task);
		if (op.kind === "evaluation.runtime.read") return task.view;
		if (op.kind === "evaluation.runtime.rows") {
			const offset = Math.max(0, op.offset ?? 0),
				rows: EvaluationResultRow[] = [];
			let bytes = 0;
			for (const row of task.rows.slice(offset, offset + Math.min(op.limit ?? 100, 500))) {
				const size = Buffer.byteLength(JSON.stringify(row));
				if (rows.length && bytes + size > 500000) break;
				rows.push(row);
				bytes += size;
			}
			return { rows, offset, nextOffset: offset + rows.length, total: task.rows.length };
		}
		if (op.kind === "evaluation.runtime.report" || op.kind === "evaluation.runtime.patch") {
			const text =
				op.kind === "evaluation.runtime.patch" ? await task.ratchet?.patch() : JSON.stringify(task.report, null, 2);
			if (text === undefined) throw new Error("No verified best-version patch is available");
			const offset = op.offset ?? 0,
				chunk = text.slice(offset, offset + 48000);
			return { text: chunk, nextOffset: offset + chunk.length, total: text.length };
		}
		if (op.action === "cancel") {
			if (["completed", "partial", "failed", "cancelled", "interrupted"].includes(task.view.state)) return task.view;
			task.abort.abort();
			if (task.batchId && task.native) getJudgmentBatch(task.batchId, task.native)?.cancel();
			task.ratchet?.stop();
			task.view.state = "cancelling";
			this.#changed(op.id, task);
		} else if (task.ratchet) {
			task.abort = new AbortController();
			if (op.action === "configure") {
				if (!op.spec) throw new Error("Configuration required");
				await task.ratchet.configure(op.spec);
				task.spec = op.spec;
			} else if (op.action === "approve") {
				if (!op.stage) throw new Error("Choose an approval stage");
				// Return immediately: the native InteractionPort owns the pending review.
				task.done = task.ratchet
					.approve(op.stage)
					.then(() => this.#refreshRatchet(op.id, task))
					.catch(error => this.#error(op.id, task!, error));
			} else if (op.action === "start" || op.action === "pilot") {
				task.view.state = "running";
				task.done = task.ratchet
					.run(op.action === "pilot")
					.then(() => this.#refreshRatchet(op.id, task))
					.catch(error => this.#error(op.id, task!, error));
			}
			await this.#refreshRatchet(op.id, task);
		} else throw new Error("This action requires a Ratchet flow; retry creates a new reviewed evaluation");
		return task.view;
	}
	#error(id: string, task: Task, error: unknown): void {
		task.ratchet?.fail(error, task.abort.signal.aborted);
		task.view.state = task.abort.signal.aborted ? "cancelled" : "failed";
		task.view.error = error instanceof Error ? error.message : String(error);
		this.#changed(id, task);
	}
	async #run(id: string, task: Task): Promise<void> {
		try {
			if (task.spec.kind === "benchmark") await this.#benchmark(id, task, task.spec);
			else if (task.spec.kind === "instruction") {
				const spec = task.spec,
					runtime = this.#runtime();
				const targets = await resolveBenchTargets(spec.models, runtime.modelRegistry, runtime.settings, () => {});
				const reports = new Map<string, IfBenchModelReport>();
				task.view.total = targets.length * (spec.turns ?? 24);
				task.report = await runIfBench({
					targets,
					runtime,
					maxTurns: spec.turns ?? 24,
					arrayLength: spec.length ?? 24,
					maxTokens: spec.maxTokens ?? 32768,
					nyaMax: spec.nyaMax ?? 8,
					par: spec.concurrency ?? 4,
					stream: this.dependencies.streamSimple ?? streamSimple,
					signal: task.abort.signal,
					now: () => performance.now(),
					randomSessionId: () => Bun.randomUUIDv7(),
					observer: {
						turnStarted: () => {},
						modelStarted: () => {},
						turnFinished: (label, row) => {
							task.rows.push({ key: `${label}:${row.turn}`, model: label, data: row });
							task.view.completed++;
							if (!row.passed) task.view.failed++;
							task.view.cost = (task.view.cost ?? 0) + row.cost;
							task.report = {
								maxTurns: spec.turns ?? 24,
								arrayLength: spec.length ?? 24,
								nyaMax: spec.nyaMax ?? 8,
								maxTokens: spec.maxTokens ?? 32768,
								models: [...reports.values()],
								partialTurns: task.rows,
							};
							this.#changed(id, task);
						},
						modelFinished: report => {
							reports.set(report.selector, report);
							task.view.metrics = [...reports.values()].map(r => ({
								id: r.selector,
								label: r.label,
								state: r.failure ? "failed" : "completed",
								completed: r.turns.length,
								total: spec.turns ?? 24,
								failed: r.failure ? 1 : 0,
								metrics: {
									turnsPassed: r.turnsPassed,
									actionsPassed: r.actionsPassed,
									durationMs: r.durationMs,
									outputTokens: r.outputTokens,
									cost: r.cost,
								},
								detail: { failure: r.failure },
							}));
							task.report = {
								maxTurns: spec.turns ?? 24,
								arrayLength: spec.length ?? 24,
								nyaMax: spec.nyaMax ?? 8,
								maxTokens: spec.maxTokens ?? 32768,
								models: [...reports.values()],
							};
							this.#changed(id, task);
						},
					},
				});
			} else if (task.spec.kind === "judgment") {
				const spec = task.spec,
					source = this.session.studioToolSession;
				if (!source) throw new Error("Judge Runtime is not initialized");
				const native: ToolSession = spec.judgeModel
					? { ...source, settings: source.settings.overlay({ "modelRoles.judge": spec.judgeModel }) }
					: source;
				task.native = native;
				const batch = spec.attachId
					? getJudgmentBatch(spec.attachId, native)?.status()
					: ((await runEvalJudgmentBatch(
							{
								op: "create",
								intent: task.title,
								items: spec.items,
								questions: spec.questions,
								concurrency: spec.concurrency ?? 32,
								retries: spec.retries ?? 1,
								minOk: spec.minOk ?? 1,
							},
							{ session: native },
						)) as JudgmentBatchStatus);
				if (!batch) throw new Error("The native batch does not belong to this evaluation session");
				task.batchId = batch.id;
				if (task.abort.signal.aborted) getJudgmentBatch(batch.id, native)?.cancel();
				await new Promise<void>((resolve, reject) => {
					const refresh = () => {
						try {
							const current = getJudgmentBatch(batch.id, native);
							if (!current) throw new Error("Native batch was closed");
							const status = current.status();
							task.view.completed = status.done;
							task.view.total = status.total;
							task.view.failed = status.failed;
							task.view.cost = status.cost;
							task.view.detail = { ...status, questions: spec.questions };
							const items: JudgmentBatchItem[] = [];
							for (let offset = 0; offset < status.done; offset += 50)
								items.push(...current.readItems(offset, 50));
							task.rows = items.map(item => ({
								key: String(item.key),
								...(item.model ? { model: item.model } : {}),
								data: item,
							}));
							task.view.metrics = Object.entries(spec.questions).map(([questionId, question]) => {
								const answers = items.flatMap(item =>
									item.answers?.[questionId] ? [item.answers[questionId]] : [],
								);
								const mean = answers.flatMap(answer =>
									answer.type === "bool" ? [answer.bool] : answer.type === "score" ? [answer.score] : [],
								);
								const confidences = answers.flatMap(answer =>
									answer.type === "choice" || answer.type === "score" ? [answer.confidence] : [],
								);
								const frequencies: Record<string, number> = {};
								for (const answer of answers)
									if (answer.type === "choice")
										frequencies[`choice:${answer.choice}`] =
											(frequencies[`choice:${answer.choice}`] ?? 0) + 1;
								return {
									id: questionId,
									label: questionId,
									state: status.running ? "running" : "completed",
									completed: answers.length,
									total: status.total,
									failed: status.failed,
									metrics: {
										mean: mean.length ? mean.reduce((sum, n) => sum + n, 0) / mean.length : null,
										confidence: confidences.length
											? confidences.reduce((sum, n) => sum + n, 0) / confidences.length
											: null,
										answered: answers.length,
										...frequencies,
									},
									detail: { question, frequencies },
								};
							});
							task.report = {
								batch: status,
								items: task.rows.map(r => r.data),
								configuration: spec.attachId ? current.studioInput() : undefined,
							};
							this.#changed(id, task);
							if (!status.running) {
								clearInterval(task.timer);
								if (status.error) task.view.error = status.error;
								resolve();
							}
						} catch (error) {
							clearInterval(task.timer);
							reject(error);
						}
					};
					task.timer = setInterval(refresh, 300);
					refresh();
				});
			} else {
				const runner = await EvaluationRatchetRunner.create(
					this.session,
					id,
					task.spec,
					() => void this.#refreshRatchet(id, task),
				);
				task.ratchet = runner;
				task.abort.signal.throwIfAborted();
				task.timer = setInterval(
					() => void this.#refreshRatchet(id, task).catch(error => this.#error(id, task, error)),
					1000,
				);
				await runner.prepare();
				await this.#refreshRatchet(id, task);
				return;
			}
			task.view.state = task.abort.signal.aborted
				? "cancelled"
				: task.view.failed
					? task.view.failed >= task.view.completed
						? "failed"
						: "partial"
					: "completed";
			if (task.spec.kind === "instruction" && !task.abort.signal.aborted) {
				const providerFailures = task.view.metrics.filter(
					row => (row.detail?.failure as { kind?: string } | undefined)?.kind === "provider",
				).length;
				task.view.state = providerFailures
					? providerFailures === task.view.metrics.length
						? "failed"
						: "partial"
					: "completed";
			}
			this.#changed(id, task);
		} catch (error) {
			this.#error(id, task, error);
		}
	}
	async #benchmark(id: string, task: Task, spec: PerformanceEvaluationSpec): Promise<void> {
		const project = (rows: readonly BenchTableRow[]) => {
			task.view.metrics = rows.map(row => {
				const r = row.report,
					stats =
						spec.profile === "mix"
							? r.byChallenge.chat
							: spec.profile === "detailed"
								? r.phases.single?.stats
								: r.stats;
				const metrics: Record<string, number | null> = {
					ttft: stats?.ttftMs.p50 ?? null,
					ttftP95: stats?.ttftMs.p95 ?? null,
					prefill: stats?.prefillTps.p50 ?? null,
					decode: stats?.generationTps.p50 ?? null,
					throughput: stats?.tokensPerSecond.p50 ?? null,
					cost: stats?.cost || null,
				};
				const catalogModel = this.session.modelRegistry
					.getAll()
					.find(model => `${model.provider}/${model.id}` === r.model);
				if (
					stats &&
					catalogModel &&
					Object.values(catalogModel.cost).some(value => typeof value === "number" && value > 0)
				)
					metrics.cost = stats.cost;
				if (r.cachePairs) {
					const cold = r.cachePairs.flatMap(pair => (pair.cold.result.ok ? [pair.cold.result.ttftMs] : []));
					const warm = r.cachePairs.flatMap(pair => (pair.warm.result.ok ? [pair.warm.result.ttftMs] : []));
					metrics["cold.ttft"] = cold.length ? metricStats(cold).p50 : null;
					metrics["warm.ttft"] = warm.length ? metricStats(warm).p50 : null;
					metrics.cacheProof = r.cachePairs.filter(pair =>
						pair.warm.observations.some(proof => proof !== "no_provider_proof"),
					).length;
					metrics.prewarmed = r.cachePairs.filter(pair => pair.coldAlreadyWarm).length;
				}
				for (const [phase, value] of Object.entries(r.phases))
					if (value) {
						metrics[`${phase}.aggregateTps`] = value.aggregateTps;
						metrics[`${phase}.ttft`] = value.stats?.ttftMs.p50 ?? null;
						metrics[`${phase}.prefill`] = value.stats?.prefillTps.p50 ?? null;
					}
				const single = r.phases.single?.aggregateTps,
					parallel = r.phases.parallel?.aggregateTps;
				metrics.scaling = single && parallel !== undefined ? parallel / single : null;
				return {
					id: r.selector,
					label: r.model,
					state: row.state,
					completed: row.progress.completed,
					total: row.progress.total,
					failed: row.progress.failed,
					metrics,
					detail: { thinking: r.thinking, stats: r.stats, byChallenge: r.byChallenge, phases: r.phases },
				};
			});
			task.rows = rows.flatMap<EvaluationResultRow>(row =>
				row.report.cachePairs
					? row.report.cachePairs.map((pair, i) => ({
							key: `${row.report.selector}:${i}`,
							model: row.report.model,
							phase: "cache",
							data: pair,
						}))
					: row.report.results.flatMap((result, i) =>
							result
								? [
										{
											key: `${row.report.selector}:${i}`,
											model: row.report.model,
											...(result.phase ? { phase: result.phase } : {}),
											data: result,
										},
									]
								: [],
						),
			);
			task.view.completed = rows.reduce((sum, r) => sum + r.progress.completed, 0);
			task.view.failed = rows.reduce((sum, r) => sum + r.progress.failed, 0);
			task.view.total = rows.reduce((sum, r) => sum + r.progress.total, 0);
			task.view.cost = task.view.metrics.some(r => r.metrics.cost !== null)
				? rows.reduce(
						(sum, r) => sum + r.report.results.reduce((n, result) => n + (result?.ok ? result.cost : 0), 0),
						0,
					)
				: null;
			task.report = { ...resolveBenchPlan(benchmarkCommand(spec)), models: rows.map(row => row.report) };
			this.#changed(id, task);
		};
		task.report = await runBenchCommand(benchmarkCommand(spec), {
			...this.dependencies,
			...(spec.cachePrefixContent === undefined ? {} : { readTextFile: async () => spec.cachePrefixContent! }),
			createRuntime: async () => this.#runtime(),
			signal: task.abort.signal,
			onProgress: project,
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			stdoutIsTTY: false,
		});
	}
	async #refreshRatchet(id: string, task: Task): Promise<void> {
		if (!task.ratchet) return;
		const snapshot = await task.ratchet.read();
		const { rows, report, ...view } = snapshot;
		const previous = JSON.stringify({ ...task.view, revision: 0 });
		task.view = { ...view, revision: task.view.revision };
		task.rows = rows;
		task.report = report;
		if (previous !== JSON.stringify({ ...task.view, revision: 0 })) this.#changed(id, task);
	}
	dispose(): void {
		for (const task of this.#tasks.values()) {
			task.abort.abort();
			task.ratchet?.stop();
			if (task.timer) clearInterval(task.timer);
			if (task.batchId && task.native) getJudgmentBatch(task.batchId, task.native)?.cancel();
		}
		this.#listeners.clear();
	}
}
