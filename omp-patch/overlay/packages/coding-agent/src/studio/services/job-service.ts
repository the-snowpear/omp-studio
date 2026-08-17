/**
 * StudioJobService - presentation-neutral AsyncJob observation and control
 * service for the Studio Jobs panel (05_AGENT_HUB_AND_JOBS.md, WP-054).
 *
 * Native semantics arrive exclusively through narrow injected ports:
 *   - snapshot/list/cancel .. AsyncJobManager (getJob/list/cancel)
 *   - hierarchy ............. AgentRegistry (parentId chain for owner scope)
 *   - agent fallback ........ hub kill semantics when a cancelled job owns a
 *                             live agent
 *
 * The service never exposes native error text or job internals (abort
 * controllers, promises). Generations are derived from native job data
 * (re-registration of the same job id is a new native generation), never from
 * renderer input.
 */

import type { AsyncJob, AsyncJobFilter } from "../../async/job-manager";

const MAX_ID_LENGTH = 512;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SETTLED_LIMIT = 50;
const RECENT_SETTLED_LIMIT = 100;
const DEFAULT_SUMMARY_LIMIT = 500;
const MAX_HIERARCHY_HOPS = 64;

export type StudioJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface StudioJobSnapshot {
	jobId: string;
	generation: number;
	ownerAgentId?: string;
	agentId?: string;
	type: "bash" | "task";
	label: string;
	status: StudioJobStatus;
	startedAt: string;
	completedAt?: string;
	summary?: string;
}

export interface StudioJobCancelReceipt {
	outcome: "cancelled" | "cancellation_requested" | "already_terminal";
	snapshot: StudioJobSnapshot;
}

/**
 * Job port. Structurally compatible with the native AsyncJobManager
 * (getJob/getRunningJobs/getRecentJobs/getAllJobs/cancel).
 */
export interface StudioJobsPort {
	getJob(id: string): AsyncJob | undefined;
	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[];
	getRecentJobs(limit?: number, filter?: AsyncJobFilter): AsyncJob[];
	getAllJobs(filter?: AsyncJobFilter): AsyncJob[];
	cancel(id: string, filter?: AsyncJobFilter): boolean;
}

/** Hierarchy port; structurally compatible with AgentRegistry.get. */
export interface StudioJobRegistryPort {
	get(id: string): { id: string; parentId?: string } | undefined;
}

/**
 * Hub fallback port: abort a live agent owned by a cancelled job. Production
 * wiring uses the same abort + tombstone release semantics as the Agent Hub.
 */
export interface StudioJobAgentAbortPort {
	abortAgent(agentId: string): Promise<void>;
}

export type StudioJobCancelAction = {
	kind: "cancelJob";
	jobId: string;
	generation: number;
	risk: "destructive";
};

export type StudioJobConfirmationGate = (action: StudioJobCancelAction) => boolean | Promise<boolean>;

export type StudioJobErrorCode =
	| "JOB_NOT_FOUND"
	| "JOB_GENERATION_CONFLICT"
	| "NOT_OWNER"
	| "CONFIRMATION_REQUIRED"
	| "CONFIRMATION_DENIED"
	| "CANCEL_FAILED"
	| "INVALID_ARGUMENT";

export class StudioJobError extends Error {
	constructor(
		readonly code: StudioJobErrorCode,
		message: string,
		readonly snapshot?: StudioJobSnapshot,
		readonly action?: StudioJobCancelAction,
	) {
		super(message);
		this.name = "StudioJobError";
	}
}

export interface StudioJobServiceOptions {
	confirmationGate?: StudioJobConfirmationGate;
	/** Hub fallback for jobs that own a live agent; absent disables the fallback. */
	abortAgent?: StudioJobAgentAbortPort;
	maxListLimit?: number;
	summaryLimit?: number;
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value)) return min;
	return Math.min(max, Math.max(min, value));
}

export class StudioJobService {
	readonly #jobs: StudioJobsPort;
	readonly #registry: StudioJobRegistryPort;
	readonly #abortAgent?: StudioJobAgentAbortPort;
	readonly #confirmationGate?: StudioJobConfirmationGate;
	readonly #maxListLimit: number;
	readonly #summaryLimit: number;
	readonly #generations = new Map<string, { generation: number; startTime: number }>();

	constructor(jobs: StudioJobsPort, registry: StudioJobRegistryPort, options: StudioJobServiceOptions = {}) {
		this.#jobs = jobs;
		this.#registry = registry;
		this.#abortAgent = options.abortAgent;
		this.#confirmationGate = options.confirmationGate;
		this.#maxListLimit = clampInt(options.maxListLimit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
		this.#summaryLimit = clampInt(options.summaryLimit ?? DEFAULT_SUMMARY_LIMIT, 1, 64 * 1024);
	}

	/**
	 * Bounded job DTOs. Default: running jobs plus the most recent settled
	 * jobs (native retention bounds the window). `includeRecent` widens the
	 * settled window. `ownerAgentId` filters to one owner (caller scope is
	 * enforced); otherwise the caller sees its own jobs, its descendants'
	 * jobs, and unowned jobs.
	 */
	list(
		options: { callerAgentId?: string; ownerAgentId?: string; includeRecent?: boolean; limit?: number } = {},
	): StudioJobSnapshot[] {
		const limit = clampInt(options.limit ?? DEFAULT_LIST_LIMIT, 1, this.#maxListLimit);
		if (options.ownerAgentId !== undefined) {
			this.#validateId(options.ownerAgentId);
			this.#assertOwnerScope(options.callerAgentId, options.ownerAgentId);
		}
		const jobs = new Map<string, AsyncJob>();
		for (const job of this.#jobs.getRunningJobs()) jobs.set(job.id, job);
		const settledLimit = options.includeRecent ? RECENT_SETTLED_LIMIT : DEFAULT_SETTLED_LIMIT;
		for (const job of this.#jobs.getRecentJobs(settledLimit)) {
			if (!jobs.has(job.id)) jobs.set(job.id, job);
		}
		const ownerFilter = options.ownerAgentId;
		const visible = [...jobs.values()]
			.filter(job => this.#canSee(options.callerAgentId, ownerFilter, job))
			.sort((a, b) => b.startTime - a.startTime);
		return visible.slice(0, limit).map(job => this.#snapshot(job));
	}

	get(jobId: string): StudioJobSnapshot {
		this.#validateId(jobId);
		const job = this.#jobs.getJob(jobId);
		if (!job) throw new StudioJobError("JOB_NOT_FOUND", `Job "${jobId}" was not found`);
		return this.#snapshot(job);
	}

	async cancel(args: {
		jobId: string;
		expectedGeneration: number;
		callerAgentId?: string;
	}): Promise<StudioJobCancelReceipt> {
		this.#validateId(args.jobId);
		this.#validateGeneration(args.expectedGeneration);
		const job = this.#jobs.getJob(args.jobId);
		if (!job) throw new StudioJobError("JOB_NOT_FOUND", `Job "${args.jobId}" was not found`);
		const generation = this.#observe(job);
		if (generation !== args.expectedGeneration) {
			throw new StudioJobError(
				"JOB_GENERATION_CONFLICT",
				`Job "${args.jobId}" changed; refresh before cancelling`,
				this.#snapshot(job),
			);
		}
		if (job.ownerId !== undefined) {
			if (args.callerAgentId === undefined) {
				throw new StudioJobError("NOT_OWNER", `Job "${args.jobId}" belongs to agent "${job.ownerId}"`);
			}
			if (args.callerAgentId !== job.ownerId && !this.#isAncestorOf(args.callerAgentId, job.ownerId)) {
				throw new StudioJobError("NOT_OWNER", `Agent "${args.callerAgentId}" cannot cancel job "${args.jobId}"`);
			}
		}
		if (job.status !== "running") {
			return { outcome: "already_terminal", snapshot: this.#snapshot(job) };
		}
		await this.#requireConfirmation({ kind: "cancelJob", jobId: args.jobId, generation, risk: "destructive" });
		const cancelled = this.#jobs.cancel(args.jobId, job.ownerId === undefined ? undefined : { ownerId: job.ownerId });
		if (!cancelled) {
			const current = this.#jobs.getJob(args.jobId);
			if (!current) throw new StudioJobError("JOB_NOT_FOUND", `Job "${args.jobId}" was not found`);
			if (current.status !== "running") {
				return { outcome: "already_terminal", snapshot: this.#snapshot(current) };
			}
			throw new StudioJobError(
				"JOB_GENERATION_CONFLICT",
				`Job "${args.jobId}" changed before it could cancel`,
				this.#snapshot(current),
			);
		}
		let agentCleanupOk = true;
		if (job.agentId !== undefined && this.#abortAgent) {
			try {
				await this.#abortAgent.abortAgent(job.agentId);
			} catch {
				agentCleanupOk = false;
			}
		}
		const current = this.#jobs.getJob(args.jobId);
		const snapshot = current ? this.#snapshot(current) : this.#snapshot({ ...job, status: "cancelled" } as AsyncJob);
		return { outcome: agentCleanupOk ? "cancelled" : "cancellation_requested", snapshot };
	}

	#snapshot(job: AsyncJob): StudioJobSnapshot {
		const generation = this.#observe(job);
		const status: StudioJobStatus = job.status === "running" && job.queued === true ? "queued" : job.status;
		const summary = (job.resultText ?? job.errorText ?? "").trim();
		return {
			jobId: job.id,
			generation,
			...(job.ownerId !== undefined ? { ownerAgentId: job.ownerId } : {}),
			...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
			type: job.type,
			label: job.label,
			status,
			startedAt: new Date(job.startTime).toISOString(),
			...(summary.length > 0
				? { summary: summary.length > this.#summaryLimit ? `${summary.slice(0, this.#summaryLimit)}…` : summary }
				: {}),
		};
	}

	/**
	 * Generation is native-port-driven: re-registration of the same job id
	 * (observed via a changed native startTime) is a new generation.
	 */
	#observe(job: AsyncJob): number {
		const recorded = this.#generations.get(job.id);
		if (recorded === undefined) {
			this.#generations.set(job.id, { generation: 1, startTime: job.startTime });
			return 1;
		}
		if (recorded.startTime !== job.startTime) {
			const generation = recorded.generation + 1;
			this.#generations.set(job.id, { generation, startTime: job.startTime });
			return generation;
		}
		return recorded.generation;
	}

	#canSee(callerAgentId: string | undefined, ownerFilter: string | undefined, job: AsyncJob): boolean {
		const ownerId = job.ownerId;
		if (ownerFilter !== undefined) return ownerId === ownerFilter;
		if (ownerId === undefined) return true; // unowned jobs are visible to every caller
		if (callerAgentId === undefined) return false; // fail closed: no caller identity, no owned rows
		if (ownerId === callerAgentId) return true;
		return this.#isAncestorOf(callerAgentId, ownerId);
	}

	#assertOwnerScope(callerAgentId: string | undefined, ownerAgentId: string): void {
		if (callerAgentId === ownerAgentId) return;
		if (callerAgentId === undefined || !this.#isAncestorOf(callerAgentId, ownerAgentId)) {
			throw new StudioJobError(
				"NOT_OWNER",
				`Agent "${callerAgentId ?? "<none>"}" cannot view jobs of "${ownerAgentId}"`,
			);
		}
	}

	#isAncestorOf(ancestorId: string, descendantId: string): boolean {
		let current: string | undefined = descendantId;
		let hops = 0;
		while (current !== undefined && hops < MAX_HIERARCHY_HOPS) {
			if (current === ancestorId) return true;
			current = this.#registry.get(current)?.parentId;
			hops += 1;
		}
		return false;
	}

	async #requireConfirmation(action: StudioJobCancelAction): Promise<void> {
		if (!this.#confirmationGate) {
			throw new StudioJobError(
				"CONFIRMATION_REQUIRED",
				"Destructive cancelJob requires host confirmation",
				undefined,
				action,
			);
		}
		const granted = await this.#confirmationGate(action);
		if (!granted) {
			throw new StudioJobError("CONFIRMATION_DENIED", "Destructive cancelJob was not confirmed");
		}
	}

	#validateId(jobId: string): void {
		if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > MAX_ID_LENGTH) {
			throw new StudioJobError("INVALID_ARGUMENT", "Job id is invalid");
		}
	}

	#validateGeneration(expectedGeneration: number): void {
		if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
			throw new StudioJobError("INVALID_ARGUMENT", "Expected generation is invalid");
		}
	}
}
