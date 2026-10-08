import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, isEnoent, prompt, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { createRatchetPrelude } from "../../ratchet/prelude-definition";
import { approvalStatus, loadState, requireState, type RatchetState } from "../../ratchet/ratchet";
import type { AgentSession } from "../../session/agent-session";
import { ensureIsolation } from "../../task/worktree";
import { ISOLATION_OWNER_FILE, writeIsolationOwner } from "../../task/isolation-ownership";
import { runStructuredSubagent } from "../../task/structured-subagent";
import type { ToolSession } from "../../tools";
import ratchetKickoff from "../../prompts/ratchet-kickoff.md" with { type: "text" };
import type { RatchetOperation, RatchetRunView, RatchetStage } from "../ratchet-protocol";
import { installStudioRatchetBoundary } from "./ratchet-boundary";
import { SessionControlError } from "./session-control-service";

interface RunRecord {
	version: 1;
	id: string;
	source: string;
	sessionId: string;
	flow: string;
	workspace: string;
	createdAt: number;
	roundsLimit: number;
	costLimit: number;
	modelCost: number;
	state: RatchetRunView["state"];
	agentId?: string;
	error?: string;
}
interface ActiveRun {
	abort: AbortController;
	done: Promise<void>;
}
export class StudioRatchetService {
	readonly #records = new Map<string, RunRecord>();
	readonly #active = new Map<string, ActiveRun>();
	readonly #locks = new Set<string>();
	readonly #guards = new Map<string, () => void>();
	readonly #saves = new Map<string, Promise<void>>();
	readonly #reviews = new Set<AbortController>();
	#disposed = false;
	#creating = false;
	constructor(readonly session: AgentSession) {}
	#source(): ToolSession {
		const value = this.session.studioToolSession;
		if (!value) throw new SessionControlError("COMMAND_BLOCKED", "Ratchet needs an initialized tool session");
		return value;
	}
	#directory(): string {
		return path.join(this.#source().cwd, ".omp", "studio-ratchet");
	}
	#tools(workspace: string): ToolSession {
		const source = this.#source();
		return {
			...source,
			cwd: workspace,
			additionalDirectories: [],
			settings: source.settings.overlay({ "ratchet.enabled": true }),
			hasUI: true,
		};
	}
	async #save(run: RunRecord): Promise<void> {
		const dest = path.join(run.source, ".omp", "studio-ratchet", run.id + ".json");
		const content = JSON.stringify(run);
		const previous = this.#saves.get(run.id) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(async () => {
				await fs.mkdir(path.dirname(dest), { recursive: true });
				const temp = dest + "." + randomUUID() + ".tmp";
				await Bun.write(temp, content);
				await fs.rename(temp, dest);
			});
		this.#saves.set(run.id, next);
		try {
			await next;
		} finally {
			if (this.#saves.get(run.id) === next) this.#saves.delete(run.id);
		}
	}
	async #load(id: string): Promise<RunRecord> {
		const existing = this.#records.get(id);
		if (existing && (this.#active.has(id) || this.#locks.has(id))) {
			if (existing.source !== this.#source().cwd) throw new Error("Ratchet workspace changed");
			return existing;
		}
		const file = Bun.file(path.join(this.#directory(), id + ".json"));
		if (file.size > 16384) throw new Error("Ratchet record exceeds its size limit");
		const run = (await file.json()) as RunRecord;
		if (
			run.version !== 1 ||
			run.id !== id ||
			run.source !== this.#source().cwd ||
			!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(run.flow) ||
			!Number.isInteger(run.roundsLimit) ||
			run.roundsLimit < 1 ||
			run.roundsLimit > 100 ||
			!Number.isFinite(run.costLimit) ||
			run.costLimit < 0.01 ||
			run.costLimit > 10000
		)
			throw new Error("Invalid Ratchet record");
		const workspace = await fs.realpath(run.workspace);
		const root = await fs.realpath(getWorktreeDir(""));
		const relative = path.relative(root, workspace);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(workspace) !== "m")
			throw new Error("Ratchet workspace is outside native isolation storage");
		const owner = (await Bun.file(path.join(path.dirname(workspace), ISOLATION_OWNER_FILE)).json()) as {
			id?: string;
		};
		if (owner.id !== "studio-ratchet-" + id) throw new Error("Ratchet workspace ownership changed");
		if (run.state === "running") {
			const probe = tryAcquireFileLock(path.join(this.#directory(), id));
			if (probe) {
				probe.release();
				run.state = "interrupted";
				run.error = "The previous Runtime disconnected. Review the retained evidence before starting again.";
			}
		}
		this.#records.set(id, run);
		return run;
	}
	async #view(run: RunRecord): Promise<RatchetRunView> {
		const state = await requireState(run.workspace, run.flow);
		return {
			id: run.id,
			flow: run.flow,
			workspace: run.workspace,
			state: run.state,
			createdAt: run.createdAt,
			roundsLimit: run.roundsLimit,
			costLimit: run.costLimit,
			modelCost: run.modelCost,
			...(run.agentId ? { agentId: run.agentId } : {}),
			...(run.error ? { error: run.error.slice(0, 8192) } : {}),
			approvals: await approvalStatus(run.workspace, state),
			rounds: state.rounds.slice(-256).map(round => ({
				round: round.round,
				variant: round.variant,
				change: round.change.slice(0, 4096),
				decision: round.decision,
				reasons: round.reasons.slice(0, 128).map(reason => reason.slice(0, 4096)),
				train: state.goal ? (round.train[state.goal.target]?.mean ?? null) : null,
				test: state.goal ? (round.test[state.goal.target]?.mean ?? null) : null,
				at: round.at,
			})),
			...(state.best ? { best: state.best.variant } : {}),
			...(state.goal ? { goal: state.goal.target } : {}),
			...(state.command ? { command: state.command } : {}),
			cases: state.cases_paths,
			harness: state.harness_paths,
			change: state.change_paths,
			offLimits: state.off_limits,
			trainCount: state.train_ids.length,
			testCount: state.test_ids.length,
		};
	}
	async #invoke(run: RunRecord, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const tools = this.#tools(run.workspace);
		const result = await createRatchetPrelude(tools).invoke(
			{ flow: run.flow, ...parameters },
			{ session: tools, toolCallId: randomUUID(), signal, context: this.#source().getToolContext?.() },
		);
		return result.details;
	}
	async execute(operation: RatchetOperation): Promise<unknown> {
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Ratchet session changed");
		if (operation.kind === "ratchet.list") {
			let names: string[];
			try {
				names = await fs.readdir(this.#directory());
			} catch (error) {
				if (isEnoent(error)) return { runs: [] };
				throw error;
			}
			const runs: RatchetRunView[] = [];
			for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).slice(-100)) {
				const run = await this.#load(name.slice(0, -5));
				runs.push(await this.#view(run));
			}
			return { runs: runs.sort((a, b) => b.createdAt - a.createdAt) };
		}
		if (operation.kind === "ratchet.create") {
			if (this.#creating) throw new SessionControlError("COMMAND_BLOCKED", "A Ratchet workspace is being prepared");
			this.#creating = true;
			try {
				const id = randomUUID();
				const isolation = await ensureIsolation(this.#source().cwd, "studio-ratchet-" + id);
				const run: RunRecord = {
					version: 1,
					id,
					source: this.#source().cwd,
					sessionId: operation.sessionId,
					flow: operation.flow,
					workspace: isolation.mergedDir,
					createdAt: Date.now(),
					roundsLimit: operation.roundsLimit,
					costLimit: operation.costLimit,
					modelCost: 0,
					state: "ready",
				};
				if (await loadState(run.workspace, run.flow))
					throw new Error("This flow already exists in the source snapshot. Choose a new flow name.");
				await this.#invoke(run, {
					action: "init",
					cases: operation.cases,
					harness: operation.harness,
					change: operation.change,
					off_limits: operation.offLimits,
					command: operation.command,
				});
				await this.#invoke(run, { action: "split", cases: operation.cohorts });
				await this.#invoke(run, {
					action: "plan",
					goal: { target: operation.metric, direction: operation.direction },
					reps: operation.reps,
					stop: { rounds: operation.roundsLimit },
				});
				await this.#save(run);
				this.#records.set(id, run);
				return await this.#view(run);
			} finally {
				this.#creating = false;
			}
		}
		let run = await this.#load(operation.id);
		if (operation.kind === "ratchet.read") return this.#view(run);
		if (operation.kind === "ratchet.stop") {
			const active = this.#active.get(run.id);
			if (!active) {
				if (run.state === "running")
					throw new SessionControlError("COMMAND_BLOCKED", "Stop this run in the session that started it");
				return this.#view(run);
			}
			active.abort.abort();
			run.state = "stopped";
			await this.#save(run);
			return this.#view(run);
		}
		if (this.#active.has(run.id) || this.#locks.has(run.id))
			throw new SessionControlError("COMMAND_BLOCKED", "This Ratchet flow is busy");
		const lease = tryAcquireFileLock(path.join(this.#directory(), run.id));
		if (!lease) throw new SessionControlError("COMMAND_BLOCKED", "Another Runtime owns this Ratchet flow");
		let leaseTransferred = false;
		this.#locks.add(run.id);
		try {
			this.#records.delete(run.id);
			run = await this.#load(operation.id);
			if (operation.kind === "ratchet.approve") {
				const state = await requireState(run.workspace, run.flow);
				const preview = await this.#preview(run, state, operation.stage);
				const review = new AbortController();
				this.#reviews.add(review);
				try {
					const result = (await this.#invoke(
						run,
						{
							action: "approve",
							stage: operation.stage,
							question: "Review the " + operation.stage + " stage for " + run.flow,
							preview,
						},
						review.signal,
					)) as { approved: boolean };
					return { approved: result.approved, run: await this.#view(run) };
				} finally {
					this.#reviews.delete(review);
				}
			}
			const state = await requireState(run.workspace, run.flow);
			const approvals = await approvalStatus(run.workspace, state);
			if (Object.values(approvals).some(value => value !== "current"))
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Inputs, grader and plan must all have current native approvals",
				);
			if (run.modelCost >= run.costLimit)
				throw new SessionControlError("COMMAND_BLOCKED", "The model cost limit has been reached");
			if (
				state.rounds.filter(round => round.decision !== "baseline" && round.decision !== "rerun").length >=
				run.roundsLimit
			)
				throw new SessionControlError("COMMAND_BLOCKED", "The round limit has been reached");
			const tools = this.#tools(run.workspace);
			const abort = new AbortController();
			const agentId = "ratchet-" + randomUUID().replaceAll("-", "").slice(0, 24);
			run.state = "running";
			run.agentId = agentId;
			delete run.error;
			await writeIsolationOwner(path.dirname(run.workspace), "studio-ratchet-" + run.id);
			await this.#save(run);
			this.#guards.get(run.id)?.();
			this.#guards.set(
				run.id,
				installStudioRatchetBoundary(
					run.workspace,
					run.flow,
					run.roundsLimit,
					() => abort.signal.aborted || run.modelCost >= run.costLimit,
				),
			);
			const startingCost = run.modelCost;
			let lastSavedAt = 0;
			const done = runStructuredSubagent({
				session: tools,
				invocationKind: "task",
				agent: "task",
				identity: { id: agentId },
				assignment: prompt.render(ratchetKickoff, { request: run.flow, tools: ["eval", "task"] }),
				keepAlive: false,
				enableIrc: false,
				signal: abort.signal,
				onProgress: progress => {
					run.modelCost = startingCost + progress.cost;
					if (run.modelCost >= run.costLimit) abort.abort();
					if (Date.now() - lastSavedAt > 1000) {
						lastSavedAt = Date.now();
						void this.#save(run).catch(() => abort.abort());
					}
				},
			})
				.then(result => {
					run.modelCost = startingCost + (result.result.usage?.cost.total ?? run.modelCost - startingCost);
					if (abort.signal.aborted) run.state = "stopped";
					else if (result.result.exitCode !== 0 || result.result.error) {
						run.state = "failed";
						run.error = result.result.error ?? "The native agent failed";
					} else run.state = "completed";
				})
				.catch(error => {
					run.state = abort.signal.aborted ? "stopped" : "failed";
					run.error = String(error).slice(0, 8192);
				})
				.finally(async () => {
					try {
						await this.#save(run);
					} finally {
						this.#active.delete(run.id);
						lease.release();
					}
				})
				.catch(error => {
					run.state = "failed";
					run.error = "Cannot persist native run status: " + String(error).slice(0, 4096);
				});
			this.#active.set(run.id, { abort, done });
			leaseTransferred = true;
			return this.#view(run);
		} finally {
			this.#locks.delete(run.id);
			if (!leaseTransferred) lease.release();
		}
	}
	async #preview(run: RunRecord, state: RatchetState, stage: RatchetStage): Promise<string> {
		const paths =
			stage === "inputs" ? state.cases_paths : stage === "grader" ? state.harness_paths : state.change_paths;
		const parts = [
			JSON.stringify(
				{
					flow: run.flow,
					workspace: run.workspace,
					stage,
					paths,
					command: state.command,
					goal: state.goal,
					repetitions: state.reps,
					stop: state.stop,
					modelCostLimitUSD: run.costLimit,
					trainCases: state.train_ids.length,
					testCases: state.test_ids.length,
					offLimits: state.off_limits,
				},
				null,
				2,
			),
		];
		let budget = 24000;
		for (const relative of paths.slice(0, 8)) {
			const target = await fs.realpath(path.resolve(run.workspace, relative));
			const rel = path.relative(await fs.realpath(run.workspace), target);
			if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Review path escapes isolation");
			const file = Bun.file(target);
			if (!(await fs.stat(target)).isFile() || file.size > budget) {
				parts.push(relative + ": open this path in the isolated workspace to review its full contents.");
				continue;
			}
			const contents = await file.text();
			budget -= contents.length;
			parts.push(relative + "\n" + contents);
		}
		return parts.join("\n\n");
	}
	dispose(): void {
		this.#disposed = true;
		for (const review of this.#reviews) review.abort();
		for (const active of this.#active.values()) active.abort.abort();
		for (const dispose of this.#guards.values()) dispose();
		this.#guards.clear();
	}
}
