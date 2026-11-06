import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { prompt, getWorktreeDir } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { ToolSession } from "../../tools";
import {
	ensureIsolation,
	captureIsolationBaseline,
	captureDeltaPatch,
	filterPatchFiles,
	patchTouchedFiles,
	type WorktreeBaseline,
} from "../../task/worktree";
import { runStructuredSubagent } from "../../task/structured-subagent";
import { writeIsolationOwner } from "../../task/isolation-ownership";
import { createRatchetPrelude } from "../../ratchet/prelude-definition";
import { loadState, requireState, approvalStatus, type RatchetStage } from "../../ratchet/ratchet";
import ratchetKickoff from "../../prompts/ratchet-kickoff.md" with { type: "text" };
import type {
	RatchetEvaluationSpec,
	EvaluationNativeSnapshot,
	EvaluationResultRow,
} from "../evaluation-workspace-protocol";
import { installStudioRatchetBoundary } from "./ratchet-boundary";

interface SavedFlow {
	version: 1;
	id: string;
	source: string;
	workspace: string;
	spec: RatchetEvaluationSpec;
	baseline: WorktreeBaseline;
	cost: number;
	state: EvaluationNativeSnapshot["state"];
	best?: { variant: string; patch: string; sha256: string };
	error?: string;
	gates: Record<string, unknown>;
}
export class EvaluationRatchetRunner {
	#abort = new AbortController();
	#active = false;
	#guard: (() => void) | undefined;
	#saveTail: Promise<void> = Promise.resolve();
	constructor(
		readonly session: AgentSession,
		readonly saved: SavedFlow,
		readonly changed: () => void = () => {},
	) {}
	get spec(): RatchetEvaluationSpec {
		return this.saved.spec;
	}
	static async create(
		session: AgentSession,
		id: string,
		spec: RatchetEvaluationSpec,
		changed: () => void,
	): Promise<EvaluationRatchetRunner> {
		const source = session.sessionManager.getCwd();
		const isolation = await ensureIsolation(source, `studio-evaluation-${id}`);
		await writeIsolationOwner(path.dirname(isolation.mergedDir), `studio-evaluation-${id}`);
		const saved: SavedFlow = {
			version: 1,
			id,
			source,
			workspace: isolation.mergedDir,
			spec,
			baseline: await captureIsolationBaseline(isolation.mergedDir, source),
			cost: 0,
			state: "preparing",
			gates: {},
		};
		const runner = new EvaluationRatchetRunner(session, saved, changed);
		await runner.#save();
		return runner;
	}
	static async restore(session: AgentSession, id: string): Promise<EvaluationRatchetRunner | undefined> {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid evaluation identity");
		const source = session.sessionManager.getCwd();
		let data: string;
		try {
			data = await fs.readFile(path.join(source, ".omp", "studio-evaluations", `${id}.json`), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const saved = JSON.parse(data) as SavedFlow;
		const root = await fs.realpath(getWorktreeDir("")),
			workspace = await fs.realpath(saved.workspace);
		const relative = path.relative(root, workspace);
		if (saved.id !== id || saved.source !== source || relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("The retained isolation is unavailable");
		saved.state = "ready";
		return new EvaluationRatchetRunner(session, saved);
	}
	#tools(): ToolSession {
		const source = this.session.studioToolSession;
		if (!source) throw new Error("Ratchet needs a native tool session");
		return {
			...source,
			cwd: this.saved.workspace,
			additionalDirectories: [],
			hasUI: true,
			settings: source.settings.overlay({ "ratchet.enabled": true }),
		};
	}
	#save(): Promise<void> {
		const text = JSON.stringify(this.saved),
			destination = path.join(this.saved.source, ".omp", "studio-evaluations", `${this.saved.id}.json`);
		this.#saveTail = this.#saveTail
			.catch(() => {})
			.then(async () => {
				await fs.mkdir(path.dirname(destination), { recursive: true });
				const temp = `${destination}.${randomUUID()}.tmp`;
				await fs.writeFile(temp, text);
				await fs.rename(temp, destination);
			});
		return this.#saveTail;
	}
	async #invoke(parameters: Record<string, unknown>): Promise<unknown> {
		const tools = this.#tools();
		const result = await createRatchetPrelude(tools).invoke(
			{ flow: this.spec.flow, ...parameters },
			{
				session: tools,
				toolCallId: randomUUID(),
				signal: this.#abort.signal,
				context: this.session.studioToolSession?.getToolContext?.(),
			},
		);
		return result.details;
	}
	async prepare(): Promise<void> {
		if (this.spec.assist) {
			await this.#agent(
				`Prepare the evaluation described below in the isolated workspace. Read xd://eval/ratchet and use its native API. Prepare inputs, runner, grader, split and plan; ask the user for missing requirements through the native ask tool. Stop before baseline execution or hillclimbing. Do not approve on the user's behalf.\n${JSON.stringify(this.spec)}`,
				true,
			);
		} else await this.configure(this.spec);
		await requireState(this.saved.workspace, this.spec.flow);
		if (this.saved.state === "cancelled" || this.saved.state === "failed") return;
		this.saved.state = "ready";
		await this.#save();
		this.changed();
	}
	async configure(spec: RatchetEvaluationSpec): Promise<void> {
		if (this.#active) throw new Error("Stop the active work before changing its configuration");
		if (spec.flow !== this.spec.flow) throw new Error("Create a new flow to change its identity");
		this.#abort = new AbortController();
		const state = await loadState(this.saved.workspace, spec.flow);
		const inputsChanged =
			JSON.stringify(spec.cases) !== JSON.stringify(this.spec.cases) ||
			JSON.stringify(spec.cohorts) !== JSON.stringify(this.spec.cohorts);
		if (state?.rounds.length && inputsChanged)
			throw new Error("Inputs are frozen after baseline. Create a new flow with the revised cases");
		await this.#invoke({
			action: "init",
			cases: spec.cases,
			harness: spec.harness,
			change: spec.change,
			off_limits: spec.offLimits,
			command: spec.command,
		});
		if (!state?.rounds.length)
			await this.#invoke({
				action: "split",
				cases: spec.cohorts,
				...(spec.testFraction === undefined ? {} : { test_fraction: spec.testFraction }),
				...(spec.seed === undefined ? {} : { seed: spec.seed }),
			});
		await this.#invoke({
			action: "plan",
			goal: {
				target: spec.metric,
				direction: spec.direction,
				hold: spec.hold ?? [],
				directions: spec.directions ?? {},
			},
			reps: spec.reps ?? 1,
			stop: { plateau: spec.plateau ?? 3, ...(spec.roundsLimit === undefined ? {} : { rounds: spec.roundsLimit }) },
			...(spec.prices ? { prices: spec.prices } : {}),
		});
		this.saved.spec = spec;
		this.saved.state = "ready";
		delete this.saved.error;
		await this.#save();
		this.changed();
	}
	async approve(stage: RatchetStage): Promise<void> {
		if (this.#active) throw new Error("Wait for the current work to finish");
		this.#abort = new AbortController();
		const state = await requireState(this.saved.workspace, this.spec.flow);
		const paths =
			stage === "inputs" ? state.cases_paths : stage === "grader" ? state.harness_paths : state.change_paths;
		const materials = [
			JSON.stringify(
				{
					stage,
					flow: state.flow,
					goal: state.goal,
					repetitions: state.reps,
					stop: state.stop,
					command: state.command,
					trainCases: state.train_ids.length,
					heldOutCases: state.test_ids.length,
					paths,
					offLimits: state.off_limits,
					modelCostLimit: this.spec.costLimit ?? null,
				},
				null,
				2,
			),
		];
		for (const relative of paths) {
			const root = await fs.realpath(this.saved.workspace),
				file = await fs.realpath(path.resolve(root, relative));
			const rel = path.relative(root, file);
			if (rel.startsWith("..") || path.isAbsolute(rel))
				throw new Error("Material path escapes the isolated workspace");
			const info = await fs.stat(file);
			materials.push(
				info.isFile() && info.size <= 64000
					? `${relative}\n${await fs.readFile(file, "utf8")}`
					: `${relative} — inspect the full material in the isolated workspace`,
			);
		}
		await this.#invoke({
			action: "approve",
			stage,
			question: `Review ${stage} · ${state.flow}`,
			preview: materials.join("\n\n"),
		});
		await this.#save();
		this.changed();
	}
	async run(pilot: boolean): Promise<void> {
		if (this.#active) throw new Error("This flow is already running");
		const state = await requireState(this.saved.workspace, this.spec.flow);
		if (Object.values(await approvalStatus(this.saved.workspace, state)).some(value => value !== "current"))
			throw new Error("Review inputs, grader and plan before running");
		if (this.spec.costLimit !== undefined && this.saved.cost >= this.spec.costLimit)
			throw new Error("The configured cost threshold was reached");
		const assignment = pilot
			? `Read xd://eval/ratchet. For flow ${JSON.stringify(this.spec.flow)}, execute only the next baseline or outstanding variant using check(), the resolved runner command, and gate(). Repair no material without a new user review. Report the native result and stop after this one variant.`
			: prompt.render(ratchetKickoff, {
					request: `Continue existing approved flow ${this.spec.flow}. ${this.spec.objective}`,
					tools: ["eval", "task", "ask"],
				});
		await this.#agent(assignment, false);
		if (this.saved.state !== "cancelled" && this.saved.state !== "failed")
			this.saved.state = pilot ? "ready" : "completed";
		await this.#save();
		this.changed();
	}
	async #agent(assignment: string, preparing: boolean): Promise<void> {
		this.#active = true;
		this.#abort = new AbortController();
		this.saved.state = preparing ? "preparing" : "running";
		delete this.saved.error;
		this.#guard?.();
		if (preparing)
			this.#guard = installStudioRatchetBoundary(
				this.saved.workspace,
				this.spec.flow,
				Number.MAX_SAFE_INTEGER,
				() => this.#abort.signal.aborted,
				undefined,
				true,
				async parameters => {
					if (parameters.action === "init") {
						Object.assign(this.saved.spec, {
							cases: parameters.cases,
							harness: parameters.harness,
							change: parameters.change,
							offLimits: parameters.off_limits ?? [],
							command: parameters.command ?? this.spec.command,
						});
					} else if (parameters.action === "split") {
						this.saved.spec.cohorts = parameters.cases as Record<string, string>;
						if (typeof parameters.test_fraction === "number")
							this.saved.spec.testFraction = parameters.test_fraction;
						if (typeof parameters.seed === "number") this.saved.spec.seed = parameters.seed;
					} else if (parameters.action === "plan") {
						const state = await requireState(this.saved.workspace, this.spec.flow);
						if (state.goal)
							Object.assign(this.saved.spec, {
								metric: state.goal.target,
								direction: state.goal.direction,
								hold: state.goal.hold,
								directions: state.goal.directions,
							});
						if (state.reps !== undefined) this.saved.spec.reps = state.reps;
						if (state.command) this.saved.spec.command = state.command;
						this.saved.spec.plateau = state.stop.plateau;
						if (state.stop.rounds !== undefined) this.saved.spec.roundsLimit = state.stop.rounds;
						this.saved.spec.prices = state.prices;
					}
					await this.#save();
					this.changed();
				},
			);
		if (!preparing)
			this.#guard = installStudioRatchetBoundary(
				this.saved.workspace,
				this.spec.flow,
				this.spec.roundsLimit ?? Number.MAX_SAFE_INTEGER,
				() =>
					this.#abort.signal.aborted ||
					(this.spec.costLimit !== undefined && this.saved.cost >= this.spec.costLimit),
				async (variant, result) => {
					this.saved.gates[variant] = result;
					const state = await requireState(this.saved.workspace, this.spec.flow);
					if (state.best?.variant === variant) {
						const delta = await captureDeltaPatch(this.saved.workspace, this.saved.baseline);
						const allowed = (file: string) =>
							state.change_paths.some(scope => file === scope || file.startsWith(scope + "/"));
						const rootPatch = filterPatchFiles(
							delta.rootPatch,
							new Set(patchTouchedFiles(delta.rootPatch).filter(allowed)),
						);
						const text =
							rootPatch +
							delta.nestedPatches
								.map(patch => {
									const selected = filterPatchFiles(
										patch.patch,
										new Set(
											patchTouchedFiles(patch.patch).filter(file =>
												allowed(patch.relativePath + "/" + file),
											),
										),
									);
									return selected ? `\n# Nested repository: ${patch.relativePath}\n${selected}` : "";
								})
								.join("");
						this.saved.best = { variant, patch: text, sha256: createHash("sha256").update(text).digest("hex") };
					}
					await this.#save();
					this.changed();
				},
			);
		const startingCost = this.saved.cost;
		try {
			await this.#save();
			const result = await runStructuredSubagent({
				session: this.#tools(),
				invocationKind: "task",
				agent: "task",
				assignment,
				identity: { id: `evaluation-${randomUUID().replaceAll("-", "").slice(0, 24)}` },
				keepAlive: false,
				enableIrc: false,
				signal: this.#abort.signal,
				onProgress: progress => {
					const nextCost = startingCost + progress.cost;
					if (nextCost !== this.saved.cost) {
						this.saved.cost = nextCost;
						void this.#save().catch(error => {
							this.saved.error = String(error);
							this.#abort.abort();
						});
					}
					if (this.spec.costLimit !== undefined && this.saved.cost >= this.spec.costLimit) this.#abort.abort();
					this.changed();
				},
			});
			this.saved.cost = startingCost + (result.result.usage?.cost.total ?? this.saved.cost - startingCost);
			if (this.#abort.signal.aborted) {
				this.saved.state = "cancelled";
				return;
			}
			if (result.result.exitCode !== 0 || result.result.error)
				throw new Error(result.result.error ?? "Native Ratchet agent failed");
		} catch (error) {
			this.saved.state = this.#abort.signal.aborted ? "cancelled" : "failed";
			this.saved.error = error instanceof Error ? error.message : String(error);
			if (!this.#abort.signal.aborted) throw error;
		} finally {
			this.#active = false;
			this.#guard?.();
			this.#guard = undefined;
			await this.#save();
			this.changed();
		}
	}
	stop(): void {
		this.#abort.abort();
		if (this.#active) this.saved.state = "cancelling";
		else this.saved.state = "cancelled";
	}
	fail(error: unknown, cancelled: boolean): void {
		this.#abort.abort();
		this.saved.state = cancelled ? "cancelled" : "failed";
		this.saved.error = error instanceof Error ? error.message : String(error);
		void this.#save();
	}
	async patch(): Promise<string> {
		const best = this.saved.best;
		if (!best || createHash("sha256").update(best.patch).digest("hex") !== best.sha256)
			throw new Error("This record has no verified best-version patch");
		return best.patch;
	}
	async read(): Promise<
		Omit<EvaluationNativeSnapshot, "revision"> & { rows: EvaluationResultRow[]; report: unknown }
	> {
		const state = await loadState(this.saved.workspace, this.spec.flow);
		const approvals = state
			? await approvalStatus(this.saved.workspace, state)
			: { inputs: "missing", grader: "missing", plan: "missing" };
		const rows = (state?.rounds ?? []).map((round, i) => ({
			key: `${round.variant}:${i}`,
			data: { ...round, gate: this.saved.gates[round.variant] },
		}));
		return {
			state: this.saved.state,
			completed: state?.rounds.length ?? 0,
			total: this.spec.roundsLimit ?? 0,
			failed: state?.rounds.filter(r => r.decision === "rerun").length ?? 0,
			cost: this.saved.cost,
			metrics: (state?.rounds ?? []).map(round => ({
				id: round.variant,
				label: round.variant,
				state: round.decision,
				completed: 1,
				total: 1,
				failed: round.errors,
				metrics: {
					train: state?.goal ? (round.train[state.goal.target]?.mean ?? null) : null,
					test: state?.goal ? (round.test[state.goal.target]?.mean ?? null) : null,
					trainHalf: state?.goal ? (round.train[state.goal.target]?.half ?? null) : null,
					testHalf: state?.goal ? (round.test[state.goal.target]?.half ?? null) : null,
				},
				detail: { change: round.change, reasons: round.reasons },
			})),
			detail: {
				configuration: this.saved.spec,
				approvals,
				workspace: this.saved.workspace,
				best: state?.best,
				nativeState: state,
				patchAvailable: !!this.saved.best,
				bestPatchVariant: this.saved.best?.variant,
				gates: this.saved.gates,
			},
			...(this.saved.error ? { error: this.saved.error } : {}),
			rows,
			report: {
				state,
				gates: this.saved.gates,
				modelCost: this.saved.cost,
				bestPatchSha256: this.saved.best?.sha256,
			},
		};
	}
}
