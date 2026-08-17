import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };

const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;

export type StudioBtwStatus = "running" | "completed" | "failed" | "aborted";

export interface StudioBtwSnapshot {
	ephemeralId: string;
	status: StudioBtwStatus;
	text: string;
	copy?: string;
	error?: { code: "INTERNAL_ERROR" | "OUTPUT_LIMIT"; message: string };
}

export interface StudioBtwSessionPort {
	readonly isStreaming: boolean;
	readonly sessionManager: {
		getSessionId(): string;
		getLeafId(): string | null;
	};
	runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }>;
	branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<{ cancelled: boolean }>;
}

export class StudioBtwError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "COMMAND_BLOCKED" | "INTERACTION_STALE" | "BUSY_STREAMING",
		message: string,
	) {
		super(message);
		this.name = "StudioBtwError";
	}
}

interface StudioBtwRecord {
	ephemeralId: string;
	branchToken: string;
	branchConsumed: boolean;
	question: string;
	status: StudioBtwStatus;
	text: string;
	textBytes: number;
	error?: StudioBtwSnapshot["error"];
	abortController: AbortController;
	originalSessionId: string;
	originalLeafId: string | null;
	assistantMessage?: AssistantMessage;
}

export interface StudioBtwServiceOptions {
	idGenerator?: () => string;
	tokenGenerator?: () => string;
	maxTextBytes?: number;
}

/** Presentation-neutral one-slot BTW side-channel service. */
export class StudioBtwService {
	readonly #listeners = new Set<(snapshot: StudioBtwSnapshot) => void>();
	readonly #idGenerator: () => string;
	readonly #tokenGenerator: () => string;
	readonly #maxTextBytes: number;
	#current: StudioBtwRecord | undefined;

	constructor(
		private readonly session: StudioBtwSessionPort,
		options: StudioBtwServiceOptions = {},
	) {
		this.#idGenerator = options.idGenerator ?? randomUUID;
		this.#tokenGenerator = options.tokenGenerator ?? randomUUID;
		this.#maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
		if (!Number.isSafeInteger(this.#maxTextBytes) || this.#maxTextBytes < 1) {
			throw new RangeError("BTW text limit must be a positive integer");
		}
	}

	onChange(listener: (snapshot: StudioBtwSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	ask(question: string): { ephemeralId: string; branchToken: string; status: "running" } {
		const trimmed = question.trim();
		if (trimmed.length === 0) throw new StudioBtwError("INVALID_ARGUMENT", "BTW question must not be empty");
		if (trimmed.length > 64 * 1024) throw new StudioBtwError("INVALID_ARGUMENT", "BTW question is too long");
		if (this.#current?.status === "running") {
			throw new StudioBtwError("BUSY_STREAMING", "A BTW request is already running");
		}
		const record: StudioBtwRecord = {
			ephemeralId: this.#idGenerator(),
			branchToken: this.#tokenGenerator(),
			branchConsumed: false,
			question: trimmed,
			status: "running",
			text: "",
			textBytes: 0,
			abortController: new AbortController(),
			originalSessionId: this.session.sessionManager.getSessionId(),
			originalLeafId: this.session.sessionManager.getLeafId(),
		};
		this.#current = record;
		this.#emit(record);
		void this.#run(record);
		return { ephemeralId: record.ephemeralId, branchToken: record.branchToken, status: "running" };
	}

	get(ephemeralId: string): StudioBtwSnapshot {
		return this.#snapshot(this.#require(ephemeralId));
	}

	abort(ephemeralId: string): { aborted: true } {
		const record = this.#require(ephemeralId);
		if (record.status !== "running") throw new StudioBtwError("INTERACTION_STALE", "BTW request is not running");
		record.status = "aborted";
		record.abortController.abort();
		this.#emit(record);
		return { aborted: true };
	}

	async branch(
		ephemeralId: string,
		branchToken: string,
	): Promise<
		{ branched: true; newSessionId: string; newLeafId: string | null } | { branched: false; reason: "cancelled" }
	> {
		const record = this.#require(ephemeralId);
		if (branchToken.length === 0) throw new StudioBtwError("INVALID_ARGUMENT", "A branch token is required");
		if (record.branchConsumed) throw new StudioBtwError("INTERACTION_STALE", "BTW branch authorization is stale");
		if (record.branchToken !== branchToken)
			throw new StudioBtwError("INVALID_ARGUMENT", "Invalid branch authorization");
		if (record.status === "running" || this.session.isStreaming) {
			throw new StudioBtwError("BUSY_STREAMING", "The session or BTW answer is still streaming");
		}
		if (record.status !== "completed" || record.assistantMessage === undefined) {
			throw new StudioBtwError("COMMAND_BLOCKED", "Only a completed BTW answer can be branched");
		}
		if (
			record.originalLeafId === null ||
			record.originalSessionId !== this.session.sessionManager.getSessionId() ||
			record.originalLeafId !== this.session.sessionManager.getLeafId()
		) {
			throw new StudioBtwError("INTERACTION_STALE", "The session changed since BTW started");
		}
		record.branchConsumed = true;
		try {
			const result = await this.session.branchFromBtw(
				record.question,
				record.assistantMessage,
				record.originalLeafId,
				record.originalSessionId,
			);
			if (result.cancelled) return { branched: false, reason: "cancelled" };
			return {
				branched: true,
				newSessionId: this.session.sessionManager.getSessionId(),
				newLeafId: this.session.sessionManager.getLeafId(),
			};
		} catch {
			throw new StudioBtwError("COMMAND_BLOCKED", "BTW branch could not be completed");
		}
	}

	branchCurrent(branchToken: string): ReturnType<StudioBtwService["branch"]> {
		if (this.#current === undefined) {
			return Promise.reject(new StudioBtwError("INTERACTION_STALE", "BTW request is stale"));
		}
		return this.branch(this.#current.ephemeralId, branchToken);
	}

	dispose(): void {
		if (this.#current?.status === "running") this.abort(this.#current.ephemeralId);
		this.#listeners.clear();
	}

	async #run(record: StudioBtwRecord): Promise<void> {
		try {
			const result = await this.session.runEphemeralTurn({
				promptText: prompt.render(btwUserPrompt, { question: record.question }),
				signal: record.abortController.signal,
				onTextDelta: delta => this.#append(record, delta),
			});
			if (this.#current !== record || record.status !== "running") return;
			if (Buffer.byteLength(result.replyText, "utf8") > this.#maxTextBytes) {
				this.#failLimit(record);
				return;
			}
			record.text = result.replyText;
			record.textBytes = Buffer.byteLength(result.replyText, "utf8");
			record.assistantMessage = assistantMessageWithReplyText(result.assistantMessage, result.replyText);
			record.status = "completed";
			this.#emit(record);
		} catch {
			if (this.#current !== record || record.status === "aborted" || record.error?.code === "OUTPUT_LIMIT") return;
			record.status = "failed";
			record.error = { code: "INTERNAL_ERROR", message: "BTW request failed" };
			this.#emit(record);
		}
	}

	#append(record: StudioBtwRecord, delta: string): void {
		if (this.#current !== record || record.status !== "running") return;
		const bytes = Buffer.byteLength(delta, "utf8");
		if (record.textBytes + bytes > this.#maxTextBytes) {
			this.#failLimit(record);
			return;
		}
		record.text += delta;
		record.textBytes += bytes;
		this.#emit(record);
	}

	#failLimit(record: StudioBtwRecord): void {
		if (record.status !== "running") return;
		record.status = "failed";
		record.error = { code: "OUTPUT_LIMIT", message: "BTW answer exceeded the output limit" };
		record.abortController.abort();
		this.#emit(record);
	}

	#require(ephemeralId: string): StudioBtwRecord {
		if (this.#current === undefined || this.#current.ephemeralId !== ephemeralId) {
			throw new StudioBtwError("INTERACTION_STALE", "BTW request is stale");
		}
		return this.#current;
	}

	#snapshot(record: StudioBtwRecord): StudioBtwSnapshot {
		const copy = record.status === "completed" ? record.text.trim() : "";
		return structuredClone({
			ephemeralId: record.ephemeralId,
			status: record.status,
			text: record.text,
			...(copy.length === 0 ? {} : { copy }),
			...(record.error === undefined ? {} : { error: record.error }),
		});
	}

	#emit(record: StudioBtwRecord): void {
		const snapshot = this.#snapshot(record);
		for (const listener of this.#listeners) listener(structuredClone(snapshot));
	}
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}
