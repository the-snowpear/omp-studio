import type {
	StudioInteractionRequiredEvent,
	StudioInteractionResolvedEvent,
	StudioOperation,
	StudioPendingInteraction,
	StudioRemoteInteractionRequest,
} from "../bridge-protocol";
import type { StudioRuntimeCommandArbiter } from "../command-arbiter";

export interface StudioInteractionPort {
	confirm(input: { commandId: string; title: string; message: string; destructive?: boolean }): Promise<boolean>;
	select(input: {
		commandId: string;
		title: string;
		options: Array<{ id: string; label: string; description?: string }>;
		multiple?: boolean;
	}): Promise<string | string[] | undefined>;
	input(input: {
		commandId: string;
		title: string;
		placeholder?: string;
		secret?: boolean;
	}): Promise<string | undefined>;
	editor(input: {
		commandId: string;
		title: string;
		content?: string;
		language?: string;
		promptStyle?: boolean;
	}): Promise<string | undefined>;
	/**
	 * Structured tool approval. Resolves `true` only for an explicit submit
	 * with `value: true`; cancel, denial or any other value resolves `false`.
	 */
	approve(input: { commandId: string; title: string; approvalType: string; details: unknown }): Promise<boolean>;
	ask(input: {
		commandId: string;
		title: string;
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options: Array<{ id: string; label: string; description?: string; preview?: string }>;
			multiple?: boolean;
			recommended?: number;
		}>;
	}): Promise<unknown>;
}

interface PendingInteraction {
	request: StudioRemoteInteractionRequest;
	owner: "gui" | "tui";
	leaseGeneration: number;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class StudioInteractionError extends Error {
	constructor(
		readonly code: "INTERACTION_STALE" | "NOT_OWNER" | "INVALID_ARGUMENT",
		message: string,
	) {
		super(message);
		this.name = "StudioInteractionError";
	}
}

/** Late-bound bridge between the Runtime-owned TUI and the active bridge dispatcher. */
export class StudioInteractionGateway implements StudioInteractionPort {
	#port: StudioRemoteInteractionPort | undefined;

	bind(port: StudioRemoteInteractionPort): void {
		if (this.#port !== undefined && this.#port !== port) {
			throw new StudioInteractionError("INTERACTION_STALE", "Another interaction bridge is already bound");
		}
		this.#port = port;
	}

	unbind(port: StudioRemoteInteractionPort): void {
		if (this.#port === port) this.#port = undefined;
	}

	pending(): StudioPendingInteraction | undefined {
		return this.#port?.pending();
	}

	confirm(input: { commandId: string; title: string; message: string; destructive?: boolean }): Promise<boolean> {
		return this.#requirePort().confirm(input);
	}

	select(input: {
		commandId: string;
		title: string;
		options: Array<{ id: string; label: string; description?: string }>;
		multiple?: boolean;
	}): Promise<string | string[] | undefined> {
		return this.#requirePort().select(input);
	}

	input(input: {
		commandId: string;
		title: string;
		placeholder?: string;
		secret?: boolean;
	}): Promise<string | undefined> {
		return this.#requirePort().input(input);
	}

	editor(input: {
		commandId: string;
		title: string;
		content?: string;
		language?: string;
		promptStyle?: boolean;
	}): Promise<string | undefined> {
		return this.#requirePort().editor(input);
	}

	approve(input: { commandId: string; title: string; approvalType: string; details: unknown }): Promise<boolean> {
		return this.#requirePort().approve(input);
	}

	ask(input: {
		commandId: string;
		title: string;
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options: Array<{ id: string; label: string; description?: string; preview?: string }>;
			multiple?: boolean;
			recommended?: number;
		}>;
	}): Promise<unknown> {
		return this.#requirePort().ask(input);
	}

	cancel(reason = "Runtime interaction was cancelled", outcome: "aborted" | "expired" = "aborted"): void {
		if (this.#port === undefined) return;
		this.#port.cancel(reason, outcome);
	}

	respondFromTui(operation: Extract<StudioOperation, { kind: "interaction.respond" }>): void {
		this.#requirePort().respond(operation, "tui");
	}

	#requirePort(): StudioRemoteInteractionPort {
		if (this.#port === undefined) {
			throw new StudioInteractionError("INTERACTION_STALE", "No interaction bridge is active");
		}
		return this.#port;
	}
}

/** Bridge-backed Runtime interaction port. It owns no presentation state. */
export class StudioRemoteInteractionPort implements StudioInteractionPort {
	#pending: PendingInteraction | undefined;

	constructor(
		private readonly arbiter: StudioRuntimeCommandArbiter,
		private readonly onOpen: (pending: StudioPendingInteraction, event: StudioInteractionRequiredEvent) => void,
		private readonly onClose: (event: StudioInteractionResolvedEvent) => void,
	) {}

	pending(): StudioPendingInteraction | undefined {
		const pending = this.#pending;
		if (pending === undefined) return undefined;
		return {
			request: structuredClone(pending.request),
			owner: pending.owner,
			leaseGeneration: pending.leaseGeneration,
		};
	}

	async confirm(input: {
		commandId: string;
		title: string;
		message: string;
		destructive?: boolean;
	}): Promise<boolean> {
		const value = await this.#request({ kind: "confirm", ...input });
		return value === true;
	}

	async select(input: {
		commandId: string;
		title: string;
		options: Array<{ id: string; label: string; description?: string }>;
		multiple?: boolean;
	}): Promise<string | string[] | undefined> {
		const value = await this.#request({ kind: "select", ...input });
		if (value === undefined || typeof value === "string") return value;
		if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
		throw new StudioInteractionError("INVALID_ARGUMENT", "Select interaction returned an invalid value");
	}

	async input(input: {
		commandId: string;
		title: string;
		placeholder?: string;
		secret?: boolean;
	}): Promise<string | undefined> {
		return await this.#stringRequest({ kind: "input", ...input });
	}

	async editor(input: {
		commandId: string;
		title: string;
		content?: string;
		language?: string;
		promptStyle?: boolean;
	}): Promise<string | undefined> {
		return await this.#stringRequest({ kind: "editor", ...input });
	}

	async approve(input: {
		commandId: string;
		title: string;
		approvalType: string;
		details: unknown;
	}): Promise<boolean> {
		const value = await this.#request({ kind: "approval", ...input });
		return value === true;
	}

	async ask(input: {
		commandId: string;
		title: string;
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options: Array<{ id: string; label: string; description?: string; preview?: string }>;
			multiple?: boolean;
			recommended?: number;
		}>;
	}): Promise<unknown> {
		return await this.#request({ kind: "ask", ...input });
	}

	respond(operation: Extract<StudioOperation, { kind: "interaction.respond" }>, owner: "gui" | "tui" = "gui"): void {
		const pending = this.#pending;
		if (pending === undefined || pending.request.interactionId !== operation.interactionId) {
			throw new StudioInteractionError("INTERACTION_STALE", "Interaction is stale");
		}
		if (pending.request.commandId !== operation.commandId || pending.owner !== owner) {
			throw new StudioInteractionError("NOT_OWNER", "Caller does not own the interaction");
		}
		this.arbiter.completeInteraction(operation.interactionId, operation.commandId, owner, pending.leaseGeneration);
		this.#pending = undefined;
		this.onClose({
			kind: "interaction.resolved",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			leaseGeneration: pending.leaseGeneration,
			outcome: operation.decision === "cancel" ? "cancelled" : "submitted",
		});
		pending.resolve(operation.decision === "cancel" ? undefined : operation.value);
	}

	transfer(
		interactionId: string | undefined,
		commandId: string,
		from: "gui" | "tui",
		to: "gui" | "tui",
	): StudioPendingInteraction {
		const pending = this.#pending;
		if (
			pending === undefined ||
			pending.request.commandId !== commandId ||
			(interactionId !== undefined && pending.request.interactionId !== interactionId)
		) {
			throw new StudioInteractionError("INTERACTION_STALE", "Interaction is stale");
		}
		const lease = this.arbiter.transferInteraction(pending.request.interactionId, from, to);
		pending.owner = lease.owner;
		pending.leaseGeneration = lease.generation;
		const full = this.pending();
		if (full === undefined) throw new Error("Interaction transfer failed");
		this.onOpen(full, {
			kind: "interaction.required",
			request: structuredClone(pending.request),
			owner: lease.owner,
			leaseGeneration: lease.generation,
		});
		return full;
	}

	cancel(reason = "Runtime interaction was cancelled", outcome: "aborted" | "expired" = "aborted"): void {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.arbiter.completeInteraction(
			pending.request.interactionId,
			pending.request.commandId,
			pending.owner,
			pending.leaseGeneration,
		);
		this.#pending = undefined;
		this.onClose({
			kind: "interaction.resolved",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			leaseGeneration: pending.leaseGeneration,
			outcome,
		});
		pending.reject(new StudioInteractionError("INTERACTION_STALE", reason));
	}

	async #stringRequest(
		input:
			| { kind: "input"; commandId: string; title: string; placeholder?: string; secret?: boolean }
			| {
					kind: "editor";
					commandId: string;
					title: string;
					content?: string;
					language?: string;
					promptStyle?: boolean;
			  },
	): Promise<string | undefined> {
		const value = await this.#request(input);
		if (value === undefined || typeof value === "string") return value;
		throw new StudioInteractionError("INVALID_ARGUMENT", `${input.kind} interaction returned an invalid value`);
	}

	#request(input: Omit<StudioRemoteInteractionRequest, "interactionId">): Promise<unknown> {
		if (this.#pending !== undefined) {
			throw new StudioInteractionError("INTERACTION_STALE", "Another interaction is already pending");
		}
		const lease = this.arbiter.openInteraction(input.commandId, "gui");
		const request = { ...input, interactionId: lease.interactionId } as StudioRemoteInteractionRequest;
		const deferred = Promise.withResolvers<unknown>();
		this.#pending = {
			request,
			owner: lease.owner,
			leaseGeneration: lease.generation,
			resolve: deferred.resolve,
			reject: deferred.reject,
		};
		const full = this.pending();
		if (full === undefined) throw new Error("Interaction registration failed");
		try {
			this.onOpen(full, {
				kind: "interaction.required",
				request: structuredClone(request),
				owner: lease.owner,
				leaseGeneration: lease.generation,
			});
		} catch (error) {
			this.cancel("Interaction publication failed");
			throw error;
		}
		return deferred.promise;
	}
}

/** Deterministic interaction port for service-level tests. */
export class StudioScriptedInteractionPort implements StudioInteractionPort {
	constructor(private readonly responses: unknown[]) {}

	confirm(_input: { commandId: string; title: string; message: string; destructive?: boolean }): Promise<boolean> {
		return Promise.resolve(this.responses.shift() === true);
	}
	select(_input: {
		commandId: string;
		title: string;
		options: Array<{ id: string; label: string; description?: string }>;
		multiple?: boolean;
	}): Promise<string | string[] | undefined> {
		return Promise.resolve(this.responses.shift() as string | string[] | undefined);
	}
	input(_input: {
		commandId: string;
		title: string;
		placeholder?: string;
		secret?: boolean;
	}): Promise<string | undefined> {
		return Promise.resolve(this.responses.shift() as string | undefined);
	}
	editor(_input: {
		commandId: string;
		title: string;
		content?: string;
		language?: string;
		promptStyle?: boolean;
	}): Promise<string | undefined> {
		return Promise.resolve(this.responses.shift() as string | undefined);
	}
	approve(_input: { commandId: string; title: string; approvalType: string; details: unknown }): Promise<boolean> {
		return Promise.resolve(this.responses.shift() === true);
	}
	ask(_input: {
		commandId: string;
		title: string;
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options: Array<{ id: string; label: string; description?: string; preview?: string }>;
			multiple?: boolean;
			recommended?: number;
		}>;
	}): Promise<unknown> {
		return Promise.resolve(this.responses.shift());
	}
}
