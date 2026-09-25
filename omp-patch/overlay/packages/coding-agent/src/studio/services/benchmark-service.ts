import { randomUUID } from "node:crypto";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { BenchDependencies, BenchTableRow } from "../../cli/bench-cli";
import type { AgentSession } from "../../session/agent-session";
import type {
	BenchmarkModelResult,
	BenchmarkOperation,
	BenchmarkRun,
	BenchmarkSnapshot,
	BenchmarkSpec,
} from "../benchmarks-protocol";
import { validateBenchmarkOperation, validateBenchmarkResult } from "../benchmarks-protocol";
import { SessionControlError } from "./session-control-service";

interface RunState {
	run: BenchmarkRun;
	controller: AbortController;
	models: BenchmarkModelResult[];
}
const clean = (value: string) => sanitizeText(value).replaceAll("\0", "").slice(0, 4000) || "Benchmark failed";
function project(rows: readonly BenchTableRow[]): BenchmarkModelResult[] {
	return rows.map(row => ({
		selector: row.report.selector,
		model: row.report.model,
		state: row.state,
		...row.progress,
		stats: row.report.stats,
		byChallenge: row.report.byChallenge,
		measurements: row.report.cachePairs
			? row.report.cachePairs.flatMap(pair =>
					[pair.cold, pair.warm].map(phase => ({
						...(phase.result.ok ? phase.result : { ...phase.result, error: clean(phase.result.error) }),
						phase: phase.phase,
						cacheObservations: phase.observations,
						...(phase.usage
							? { cacheReadTokens: phase.usage.cacheReadTokens, cacheWriteTokens: phase.usage.cacheWriteTokens }
							: {}),
					})),
				)
			: row.report.results
					.filter(Boolean)
					.map(result => (result.ok ? { ...result } : { ...result, error: clean(result.error) })),
	}));
}

/** Standalone native benchmark work; no AgentSession clone and no automatic transcript/model follow-up. */
export class StudioBenchmarkService {
	readonly #runs = new Map<string, RunState>();
	readonly #unsubscribe: () => void;
	#disposed = false;
	constructor(
		readonly session: AgentSession,
		readonly dependencies: Pick<BenchDependencies, "streamSimple" | "now" | "random"> = {},
	) {
		this.#unsubscribe =
			session.registerSessionChangeCallback?.(() => {
				for (const [id, state] of this.#runs)
					if (state.run.sessionId !== session.sessionId) {
						this.#cancel(state);
						if (state.run.state !== "running" && state.run.state !== "cancelling") this.#runs.delete(id);
					}
			}) ?? (() => {});
	}
	get running(): boolean {
		return [...this.#runs.values()].some(state => state.run.state === "running" || state.run.state === "cancelling");
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		for (const state of this.#runs.values()) this.#cancel(state);
	}
	#cancel(state: RunState): void {
		if (state.run.state !== "running") return;
		state.run.state = "cancelling";
		state.controller.abort();
	}
	async execute(operation: BenchmarkOperation): Promise<unknown> {
		validateBenchmarkOperation(operation);
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Benchmarks require the current active session");
		const result = this.#execute(operation);
		validateBenchmarkResult(operation.kind, result);
		return structuredClone(result);
	}
	#execute(operation: BenchmarkOperation): unknown {
		if (operation.kind === "benchmarks.list")
			return {
				runs: [...this.#runs.values()]
					.filter(state => state.run.sessionId === operation.sessionId)
					.map(state => state.run),
			};
		if (operation.kind === "benchmarks.start") {
			if (this.running)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Wait for or cancel the current benchmark before starting another",
				);
			if (this.#runs.size >= 10)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Close an old benchmark before starting another (10 retained runs)",
				);
			const catalog = this.session.modelRegistry.getAll();
			for (const selector of operation.spec.models) {
				if (
					!catalog.some(model => `${model.provider}/${model.id}` === selector && (model.kind ?? "chat") === "chat")
				)
					throw new SessionControlError(
						"INVALID_ARGUMENT",
						"Select exact chat model IDs from the current Runtime catalog",
					);
			}
			const state: RunState = {
				run: {
					id: "bench-" + randomUUID(),
					sessionId: operation.sessionId,
					createdAt: Date.now(),
					state: "running",
					spec: structuredClone(operation.spec),
				},
				controller: new AbortController(),
				models: [],
			};
			this.#runs.set(state.run.id, state);
			void this.#run(state, catalog);
			return { run: state.run };
		}
		const state = this.#runs.get(operation.id);
		if (!state || state.run.sessionId !== operation.sessionId)
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"Benchmark is unavailable in this session; saved results remain in the artifact library",
			);
		if (operation.kind === "benchmarks.read")
			return { run: state.run, models: state.models } satisfies BenchmarkSnapshot;
		if (operation.kind === "benchmarks.cancel") {
			this.#cancel(state);
			return { run: state.run };
		}
		if (state.run.state === "running" || state.run.state === "cancelling")
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Cancel the benchmark and wait for it to stop before closing it",
			);
		this.#runs.delete(state.run.id);
		return { closed: true };
	}
	async #run(state: RunState, catalog: ReturnType<AgentSession["modelRegistry"]["getAll"]>): Promise<void> {
		const registry = this.session.modelRegistry;
		const cwd = this.session.sessionManager.getCwd();
		const settings = this.session.settings;
		try {
			const { runBenchCommand } = await import("../../cli/bench-cli");
			const { streamSimple } = await import("@oh-my-pi/pi-ai");
			const stream = this.dependencies.streamSimple ?? streamSimple;
			const spec: BenchmarkSpec = state.run.spec;
			await runBenchCommand(
				{
					models: spec.models,
					flags: {
						json: true,
						...(spec.profile === "cache"
							? {
									cache: true,
									cachePairs: spec.runs,
									cacheConcurrency: spec.concurrency,
									cachePrefixBytes: spec.cachePrefixBytes,
								}
							: {
									profile: spec.profile,
									runs: spec.runs,
									par: spec.concurrency,
									prefillBytes: spec.prefillBytes,
								}),
						...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
						...(spec.prompt ? { prompt: spec.prompt } : {}),
					},
				},
				{
					...this.dependencies,
					signal: state.controller.signal,
					createRuntime: async () => ({
						settings,
						modelRegistry: {
							getAll: () => catalog,
							getAvailable: () => catalog,
							getApiKey: registry.getApiKey.bind(registry),
							resolver: registry.resolver.bind(registry),
							hasConfiguredAuth: registry.hasConfiguredAuth.bind(registry),
						},
					}),
					streamSimple: (model, context, options) => {
						if (
							this.#disposed ||
							state.run.sessionId !== this.session.sessionId ||
							cwd !== this.session.sessionManager.getCwd()
						)
							this.#cancel(state);
						state.controller.signal.throwIfAborted();
						return stream(model, context, options);
					},
					onProgress: rows => {
						state.models = project(rows);
					},
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					stdoutIsTTY: false,
				},
			);
			state.run.state = state.controller.signal.aborted ? "cancelled" : "completed";
		} catch (error) {
			state.run.state = state.controller.signal.aborted ? "cancelled" : "failed";
			if (!state.controller.signal.aborted)
				state.run.error = clean(error instanceof Error ? error.message : String(error));
		} finally {
			state.run.finishedAt = Date.now();
			if (state.run.sessionId !== this.session.sessionId || this.#disposed) this.#runs.delete(state.run.id);
		}
	}
}
