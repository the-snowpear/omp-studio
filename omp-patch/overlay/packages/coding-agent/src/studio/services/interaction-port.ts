import type {
	StudioInteractionRequiredEvent,
	StudioInteractionResolvedEvent,
	StudioOperation,
	StudioPendingInteraction,
	StudioRemoteInteractionRequest,
} from "../bridge-protocol";
import type { StudioRuntimeCommandArbiter } from "../command-arbiter";
import type { CfgApproval } from "../../internal-urls/cfg-protocol";
import type { ExtensionApprovalAnswer, ExtensionApprovalGrant } from "../../extensibility/extensions/types";
import {
	fieldError,
	isArrayChoice,
	textValue,
	type HtmlFormValue,
	type OptionNote,
} from "@oh-my-pi/pi-tui/html-form/data";
import { spansText, type ChoiceOption } from "@oh-my-pi/pi-tui/html-form/parse";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { FormSubmitValue, InteractionForm, InteractionFormField } from "../form-protocol";
import { truncateUtf8 } from "./conversation-sanitizer";

const FORM_SUMMARY_MAX_BYTES = 480;
type InteractionInput<T = StudioRemoteInteractionRequest> = T extends StudioRemoteInteractionRequest
	? Omit<T, "interactionId">
	: never;

export interface StudioFormInput {
	commandId: string;
	title: string;
	form: InteractionForm;
	timeoutMs?: number;
	/** Local native cancellation only; never projected into the pending request or Bridge DTO. */
	signal?: AbortSignal;
}

/** A tool approval request; `session`/`grants` mirror the upstream approval prompt's extra choices. */
export interface StudioApprovalInput {
	commandId: string;
	title: string;
	approvalType: string;
	details: unknown;
	session?: string;
	grants?: readonly ExtensionApprovalGrant[];
}

/**
 * Map a submitted approval value to an answer. `true` is the legacy "approve"
 * submit; only choices the request offered are honoured, anything else denies.
 */
export function approvalAnswerFromValue(
	value: unknown,
	offered: Pick<StudioApprovalInput, "session" | "grants">,
): ExtensionApprovalAnswer {
	if (value === true || value === "once") return "once";
	if (value === "session" && offered.session !== undefined) return "session";
	if (typeof value === "object" && value !== null) {
		const { grant, always } = value as { grant?: unknown; always?: unknown };
		if (offered.grants?.some(item => item.scope === grant)) {
			return { grant: grant as ExtensionApprovalGrant["scope"], always: always === true };
		}
	}
	return "deny";
}

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
	 * Structured tool approval. `session` and `grants` are the extra choices
	 * offered; an answer outside them, a cancel or a denial resolves `deny`.
	 */
	approve(input: StudioApprovalInput): Promise<ExtensionApprovalAnswer>;
	ask(input: {
		commandId: string;
		title: string;
		acceptImages?: boolean;
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options: Array<{ id: string; label: string; description?: string; preview?: string }>;
			multiple?: boolean;
			recommended?: number;
		}>;
	}): Promise<unknown>;
	form(input: StudioFormInput): Promise<FormSubmitValue | undefined>;
}

/** One executing-service check, before resolving the interaction; a failed submission leaves the card open. */
export function formResultFromValue(value: unknown, form: InteractionForm): FormSubmitValue {
	if (!isRecord(value) || !isRecord(value.data)) {
		throw new StudioInteractionError("INVALID_ARGUMENT", "Form interaction requires submitted data");
	}
	const data: Record<string, HtmlFormValue> = Object.fromEntries(form.hidden);
	const byName = new Map<string, InteractionFormField[]>();
	for (const field of form.fields) {
		if (!field.name) continue;
		const fields = byName.get(field.name) ?? [];
		fields.push(field);
		byName.set(field.name, fields);
	}
	const timedOut = value.timedOut === true;
	for (const [name, fields] of byName) {
		const raw = Object.hasOwn(value.data, name) ? value.data[name] : undefined;
		if (raw === undefined) {
			const error = !timedOut && fields.length === 1 ? fieldError(fields[0]!, undefined) : undefined;
			if (error) throw new StudioInteractionError("INVALID_ARGUMENT", `${fields[0]!.question}: ${error}`);
			continue; // Unchecked controls contribute nothing: hidden/earlier values are not erased.
		}
		if (
			!(
				typeof raw === "string" ||
				(typeof raw === "number" && Number.isFinite(raw)) ||
				(Array.isArray(raw) && raw.every(entry => typeof entry === "string"))
			)
		) {
			throw new StudioInteractionError("INVALID_ARGUMENT", `Invalid value for ${fields[0]!.question}`);
		}
		const submitted = raw as HtmlFormValue;
		const field = [...fields].reverse().find(candidate => {
			if (candidate.kind === "text")
				return (
					typeof submitted === "string" ||
					(typeof submitted === "number" && (candidate.type === "number" || candidate.type === "range"))
				);
			if (isArrayChoice(candidate) !== Array.isArray(submitted) || typeof submitted === "number") return false;
			const picked = Array.isArray(submitted) ? submitted : [submitted];
			return (
				candidate.other ||
				picked.every(pick => candidate.options.some(option => !option.disabled && option.value === pick))
			);
		});
		const hidden = Object.hasOwn(data, name) && data[name] === submitted;
		if (!field && !hidden)
			throw new StudioInteractionError("INVALID_ARGUMENT", `Invalid choice for ${fields[0]!.question}`);
		// Duplicate names deliberately collapse in native data. Their overwritten individual drafts cannot
		// be revalidated from that record; do not reinterpret one field's final value as every field's answer.
		const normalized = field?.kind === "text" ? textValue(field, String(submitted)) : submitted;
		const error =
			!timedOut && fields.length === 1 ? fieldError(fields[0]!, field ? normalized : undefined) : undefined;
		if (error) throw new StudioInteractionError("INVALID_ARGUMENT", `${fields[0]!.question}: ${error}`);
		Object.defineProperty(data, name, { value: normalized, enumerable: true, configurable: true, writable: true });
	}
	const notes: OptionNote[] = [];
	if (Array.isArray(value.notes)) {
		for (const note of value.notes) {
			if (
				!isRecord(note) ||
				typeof note.name !== "string" ||
				typeof note.value !== "string" ||
				typeof note.text !== "string"
			)
				continue;
			const fields = byName.get(note.name) ?? [];
			const matchesOption = (option: ChoiceOption) =>
				!option.disabled &&
				option.value === note.value &&
				(note.option === undefined ||
					(spansText(option.label).replace(/\s+/g, " ").trim() || option.value) === note.option);
			const field = fields.find(
				candidate =>
					candidate.kind === "choice" &&
					(note.question === undefined || candidate.question === note.question) &&
					candidate.options.some(matchesOption),
			);
			if (field?.kind !== "choice") continue;
			const option = field.options.find(matchesOption)!;
			const picked = data[field.name];
			if (
				(fields.length === 1 && !(Array.isArray(picked) ? picked.includes(note.value) : picked === note.value)) ||
				!note.text.trim()
			)
				continue;
			notes.push({
				name: field.name,
				question: field.question,
				option: spansText(option.label).replace(/\s+/g, " ").trim() || option.value,
				value: option.value,
				text: note.text.trim(),
			});
		}
	}
	return { data, ...(notes.length ? { notes } : {}), ...(timedOut ? { timedOut: true } : {}) };
}

interface PendingInteraction {
	request: StudioRemoteInteractionRequest;
	/** Transient form body. Never in a snapshot, required event or ledger. */
	form?: InteractionForm;
	owner: "gui" | "tui";
	leaseGeneration: number;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface WaitingInteraction {
	input: InteractionInput;
	form?: InteractionForm;
	deferred: PromiseWithResolvers<unknown>;
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
	#generation = 0;

	get generation(): number {
		return this.#generation;
	}

	constructor(readonly onNotice?: (message: string, level: "info" | "warning" | "error") => void) {}

	notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		this.onNotice?.(message, level);
	}

	bind(port: StudioRemoteInteractionPort): void {
		if (this.#port !== undefined && this.#port !== port) {
			throw new StudioInteractionError("INTERACTION_STALE", "Another interaction bridge is already bound");
		}
		if (this.#port !== port) {
			this.#port = port;
			this.#generation++;
		}
	}

	unbind(port: StudioRemoteInteractionPort): void {
		if (this.#port !== port) return;
		port.cancel("Interaction bridge generation ended");
		this.#port = undefined;
		this.#generation++;
	}

	pending(): StudioPendingInteraction | undefined {
		return this.#port?.pending();
	}

	approveConfiguration(
		input: { commandId: string; title: string; details: unknown },
		timeoutMs: number,
	): Promise<CfgApproval> {
		return this.#requirePort().approveConfiguration(input, timeoutMs);
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

	approve(input: StudioApprovalInput): Promise<ExtensionApprovalAnswer> {
		return this.#requirePort().approve(input);
	}

	ask(input: {
		commandId: string;
		title: string;
		acceptImages?: boolean;
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

	form(input: StudioFormInput): Promise<FormSubmitValue | undefined> {
		return this.#requirePort().form(input);
	}

	readForm(interactionId: string, leaseGeneration: number): { form: InteractionForm } {
		return this.#requirePort().readForm(interactionId, leaseGeneration);
	}

	cancel(reason = "Runtime interaction was cancelled", outcome: "aborted" | "expired" = "aborted"): void {
		if (this.#port === undefined) return;
		this.#port.cancel(reason, outcome);
	}

	cancelCommand(
		commandId: string,
		reason = "Runtime interaction was cancelled",
		outcome: "aborted" | "expired" = "aborted",
	): void {
		this.#port?.cancelCommand(commandId, reason, outcome);
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
	#waiting: WaitingInteraction[] = [];

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

	async approve(input: StudioApprovalInput): Promise<ExtensionApprovalAnswer> {
		const value = await this.#request({ kind: "approval", ...input });
		return approvalAnswerFromValue(value, input);
	}

	async approveConfiguration(
		input: { commandId: string; title: string; details: unknown },
		timeoutMs: number,
	): Promise<CfgApproval> {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			this.cancelCommand(input.commandId, "Configuration approval expired", "expired");
		}, timeoutMs);
		try {
			const request = { kind: "approval" as const, approvalType: "configuration", ...input };
			const value = await this.#request(request);
			return value === "once" || value === "session" ? value : "deny";
		} catch {
			return timedOut ? "timeout" : "deny";
		} finally {
			clearTimeout(timer);
		}
	}

	async ask(input: {
		commandId: string;
		title: string;
		acceptImages?: boolean;
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

	async form(input: StudioFormInput): Promise<FormSubmitValue | undefined> {
		const { form, signal, ...base } = input;
		signal?.throwIfAborted();
		const intro = form.sections.flatMap(section => section.blocks).find(block => block.kind === "text");
		const caption = intro?.kind === "text" ? spansText(intro.spans) : (form.fields[0]?.question ?? base.title);
		const short = truncateUtf8(caption.replace(/\s+/g, " ").trim(), FORM_SUMMARY_MAX_BYTES);
		const summary = short.text + (short.truncated ? "…" : "");
		const cancel = () => this.cancelCommand(base.commandId, "Form was aborted");
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const value = (await this.#request(
				{
					kind: "form",
					...base,
					summary,
					fieldCount: form.fields.length,
					sectionCount: form.sections.filter(section => section.blocks.some(block => block.kind === "field"))
						.length,
				},
				form,
			)) as FormSubmitValue | undefined;
			signal?.throwIfAborted();
			return value;
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	}

	readForm(interactionId: string, leaseGeneration: number): { form: InteractionForm } {
		const pending = this.#pending;
		if (pending?.request.kind !== "form" || pending.request.interactionId !== interactionId || !pending.form) {
			throw new StudioInteractionError("INTERACTION_STALE", "Form interaction is stale");
		}
		if (pending.owner !== "gui") throw new StudioInteractionError("NOT_OWNER", "Caller does not own the form");
		if (pending.leaseGeneration !== leaseGeneration)
			throw new StudioInteractionError("INTERACTION_STALE", "Form lease is stale");
		return { form: pending.form };
	}

	respond(operation: Extract<StudioOperation, { kind: "interaction.respond" }>, owner: "gui" | "tui" = "gui"): void {
		const pending = this.#pending;
		if (pending === undefined || pending.request.interactionId !== operation.interactionId) {
			throw new StudioInteractionError("INTERACTION_STALE", "Interaction is stale");
		}
		if (pending.request.commandId !== operation.commandId || pending.owner !== owner) {
			throw new StudioInteractionError("NOT_OWNER", "Caller does not own the interaction");
		}
		if (operation.leaseGeneration !== undefined && operation.leaseGeneration !== pending.leaseGeneration) {
			throw new StudioInteractionError("INTERACTION_STALE", "Interaction lease is stale");
		}
		const value =
			operation.decision === "cancel"
				? undefined
				: pending.request.kind === "form"
					? formResultFromValue(operation.value, pending.form!)
					: operation.value;
		this.arbiter.completeInteraction(operation.interactionId, operation.commandId, owner, pending.leaseGeneration);
		delete pending.form;
		this.#pending = undefined;
		this.onClose({
			kind: "interaction.resolved",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			leaseGeneration: pending.leaseGeneration,
			outcome: operation.decision === "cancel" ? "cancelled" : "submitted",
		});
		pending.resolve(value);
		this.#drain();
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
		for (const queued of this.#waiting)
			queued.deferred.reject(new StudioInteractionError("INTERACTION_STALE", reason));
		this.#waiting = [];
		this.#cancelPending(reason, outcome);
	}

	cancelCommand(
		commandId: string,
		reason = "Runtime interaction was cancelled",
		outcome: "aborted" | "expired" = "aborted",
	): void {
		this.#waiting = this.#waiting.filter(queued => {
			if (queued.input.commandId !== commandId) return true;
			queued.deferred.reject(new StudioInteractionError("INTERACTION_STALE", reason));
			return false;
		});
		if (this.#pending?.request.commandId === commandId) this.#cancelPending(reason, outcome);
		this.#drain();
	}

	#cancelPending(reason: string, outcome: "aborted" | "expired"): void {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.arbiter.completeInteraction(
			pending.request.interactionId,
			pending.request.commandId,
			pending.owner,
			pending.leaseGeneration,
		);
		delete pending.form;
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

	#request(input: InteractionInput, form?: InteractionForm): Promise<unknown> {
		const deferred = Promise.withResolvers<unknown>();
		this.#waiting.push({ input, deferred, ...(form === undefined ? {} : { form }) });
		this.#drain();
		return deferred.promise;
	}

	#drain(): void {
		if (this.#pending) return;
		const queued = this.#waiting.shift();
		if (!queued) return;
		try {
			this.#open(queued.input, queued.form).then(queued.deferred.resolve, queued.deferred.reject);
		} catch (error) {
			queued.deferred.reject(error);
			this.#drain();
		}
	}

	#open(input: InteractionInput, form?: InteractionForm): Promise<unknown> {
		const lease = this.arbiter.openInteraction(input.commandId, "gui");
		const request = { ...input, interactionId: lease.interactionId } as StudioRemoteInteractionRequest;
		const deferred = Promise.withResolvers<unknown>();
		this.#pending = {
			request,
			...(form === undefined ? {} : { form }),
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
			this.#cancelPending("Interaction publication failed", "aborted");
			this.#drain();
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
	approve(input: StudioApprovalInput): Promise<ExtensionApprovalAnswer> {
		return Promise.resolve(approvalAnswerFromValue(this.responses.shift(), input));
	}
	ask(_input: {
		commandId: string;
		title: string;
		acceptImages?: boolean;
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
	form(input: StudioFormInput): Promise<FormSubmitValue | undefined> {
		input.signal?.throwIfAborted();
		const value = this.responses.shift();
		return Promise.resolve(value === undefined ? undefined : formResultFromValue(value, input.form));
	}
}
