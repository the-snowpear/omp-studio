import type { EvaluationOperation } from "../evaluation-protocol";
import type { StudioJobService } from "./job-service";

export class StudioEvaluationError extends Error {
	constructor(
		readonly code:
			| "INVALID_ARGUMENT"
			| "CAPABILITY_UNAVAILABLE"
			| "COMMAND_BLOCKED"
			| "JOB_GENERATION_CONFLICT"
			| "NOT_OWNER",
		message: string,
	) {
		super(message);
	}
}

/** Native eval handlers keep authorization, policy, lifecycle and retained results. */
export interface StudioEvaluationPorts {
	owner(): string;
	prelude(name: string, parameters: unknown, signal: AbortSignal): Promise<unknown>;
	read(path: string, signal: AbortSignal): Promise<unknown>;
	agent(parameters: unknown, signal: AbortSignal): Promise<{ id: string }>;
	completion(parameters: unknown, signal: AbortSignal): Promise<{ id: string }>;
	completionIdentity(id: string): object | undefined;
	status(kind: "agent" | "completion", id: string, signal: AbortSignal): Promise<unknown>;
	wait(kind: "agent" | "completion", id: string, timeoutMs: number, signal: AbortSignal): Promise<unknown>;
	cancelCompletion(id: string, signal: AbortSignal): Promise<unknown>;
	pool(name: string, signal: AbortSignal): Promise<unknown>;
	jobs: StudioJobService;
}

export class StudioEvaluationService {
	readonly #completionGenerations = new Map<string, { identity: object; generation: number }>();
	#nextGeneration = 0;
	constructor(readonly ports: StudioEvaluationPorts) {}

	async execute(operation: EvaluationOperation): Promise<unknown> {
		const timeoutMs = "timeoutMs" in operation ? (operation.timeoutMs ?? 30_000) : 30_000;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new StudioEvaluationError("COMMAND_BLOCKED", "Evaluation timed out"));
				}, timeoutMs + 250);
			});
			const result = await Promise.race([this.#execute(operation, controller.signal, timeoutMs), timeout]);
			if (new TextEncoder().encode(JSON.stringify(result) ?? "null").length > 256 * 1024) {
				throw new StudioEvaluationError("COMMAND_BLOCKED", "Evaluation result exceeds the 256 KiB bridge limit");
			}
			return result;
		} finally {
			clearTimeout(timer);
		}
	}

	#generation(kind: "agent" | "completion", id: string, expected?: number): number {
		let generation: number;
		if (kind === "agent") {
			const job = this.ports.jobs.get(id);
			if (job.ownerAgentId !== this.ports.owner())
				throw new StudioEvaluationError("NOT_OWNER", "Eval handle belongs to another owner");
			generation = job.generation;
		} else {
			const identity = this.ports.completionIdentity(id);
			if (!identity)
				throw new StudioEvaluationError(
					"COMMAND_BLOCKED",
					"Completion handle expired or is not owned by this session",
				);
			let entry = this.#completionGenerations.get(id);
			if (entry?.identity !== identity) {
				entry = { identity, generation: ++this.#nextGeneration };
				this.#completionGenerations.set(id, entry);
				if (this.#completionGenerations.size > 1200)
					this.#completionGenerations.delete(this.#completionGenerations.keys().next().value!);
			}
			generation = entry.generation;
		}
		if (expected !== undefined && generation !== expected)
			throw new StudioEvaluationError("JOB_GENERATION_CONFLICT", "Eval handle changed; refresh before acting");
		return generation;
	}

	async #execute(op: EvaluationOperation, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
		switch (op.kind) {
			case "browser.evaluate": {
				if (op.target?.elementHandle !== undefined)
					throw new StudioEvaluationError(
						"INVALID_ARGUMENT",
						"Use tab element handles inside expression; target.elementHandle is unsupported",
					);
				const name = op.target?.tabId ?? "main";
				if (op.target?.url)
					await this.ports.prelude(
						"browser",
						{ action: "open", name, url: op.target.url, timeout: timeoutMs / 1000 },
						signal,
					);
				return this.ports.prelude(
					"browser",
					{ action: "run", name, code: op.expression, timeout: timeoutMs / 1000 },
					signal,
				);
			}
			case "computer.evaluate":
				if (op.target !== undefined)
					throw new StudioEvaluationError(
						"INVALID_ARGUMENT",
						"Use desktop handles inside action; computer target is unsupported",
					);
				return this.ports.prelude(
					"computer",
					{ action: "run", code: op.action, timeout: timeoutMs / 1000 },
					signal,
				);
			case "image.read":
				return this.ports.read(`${op.image}?q=${encodeURIComponent(op.question)}`, signal);
			case "video.metadata":
				return this.ports.read(op.attachmentId, signal);
			case "video.frame":
				return this.ports.read(`${op.attachmentId}:${op.timestampMs / 1000}`, signal);
			case "terminal.image":
				return { content: [{ type: "image", ...op.result }] };
			case "eval.agent.start": {
				const handle = await this.ports.agent({ agent: op.definition, prompt: op.assignment }, signal);
				const generation = this.#generation("agent", handle.id);
				const result =
					op.async === false
						? await this.ports.wait("agent", handle.id, timeoutMs, signal)
						: await this.ports.status("agent", handle.id, signal);
				return { jobId: handle.id, generation, resultUri: `agent://${handle.id}`, result };
			}
			case "eval.completion.start": {
				const { kind: _kind, ...parameters } = op;
				const handle = await this.ports.completion(parameters, signal);
				return {
					jobId: handle.id,
					generation: this.#generation("completion", handle.id),
					result: await this.ports.status("completion", handle.id, signal),
				};
			}
			case "eval.agent.status":
			case "eval.agent.wait":
			case "eval.agent.cancel":
			case "eval.completion.status":
			case "eval.completion.wait":
			case "eval.completion.cancel": {
				const kind = op.kind.startsWith("eval.agent.") ? "agent" : "completion";
				const generation = this.#generation(kind, op.jobId, op.expectedGeneration);
				let result: unknown;
				if (op.kind.endsWith(".cancel"))
					result =
						kind === "agent"
							? await this.ports.jobs.cancel({
									jobId: op.jobId,
									expectedGeneration: generation,
									callerAgentId: this.ports.owner(),
								})
							: await this.ports.cancelCompletion(op.jobId, signal);
				else
					result = op.kind.endsWith(".wait")
						? await this.ports.wait(kind, op.jobId, timeoutMs, signal)
						: await this.ports.status(kind, op.jobId, signal);
				this.#generation(kind, op.jobId, generation);
				return { jobId: op.jobId, generation, result };
			}
			case "eval.workpool.status":
				if (op.ownerAgentId !== undefined && op.ownerAgentId !== this.ports.owner())
					throw new StudioEvaluationError("NOT_OWNER", "Workpool belongs to another owner");
				return this.ports.pool(op.name, signal);
		}
	}
}
