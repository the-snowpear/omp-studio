import { randomUUID } from "node:crypto";
import { BtwHistoryStore, type BtwHistoryRecord, getBtwTurns } from "../../session/btw-history";
import type { BtwTopicSummary } from "../runtime-upgrade-protocol";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import { CONVERSATION_LIVE_COALESCE_INTERVAL_MS } from "./conversation-live-projector";

const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;

export type StudioBtwStatus = "running" | "completed" | "failed" | "aborted";

export interface StudioBtwSnapshot {
	sessionId?: string;
	topicId?: string;
	question?: string;
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
		getArtifactsDir?(): string | null;
	};
	runEphemeralTurn(args: {
		promptText: string;
		history?: readonly Message[];
		conversationKey?: string;
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
	topicId: string;
	prior?: BtwHistoryRecord;
	history?: Message[];
	createdAt: number;
	conversationKey: string;
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
	/** Streaming-emit coalesce window; tests shorten it. */
	coalesceIntervalMs?: number;
}

/**
 * Presentation-neutral one-slot BTW side-channel service.
 *
 * The snapshot carries the whole answer so far, and every hop downstream
 * (projector envelope, per-listener copy, Bridge frame) copies it again. Emitting
 * one snapshot per text delta therefore costs O(answer²) per answer, so streaming
 * emits are coalesced onto the same frame budget the conversation stream uses.
 * Coalescing is lossless — the accumulated answer lives on the record — and only
 * ever delays a `running` snapshot: every terminal transition emits immediately
 * and cancels the pending frame.
 */
export class StudioBtwService {
	readonly #listeners = new Set<(snapshot: StudioBtwSnapshot) => void>();
	readonly #idGenerator: () => string;
	readonly #tokenGenerator: () => string;
	readonly #maxTextBytes: number;
	readonly #coalesceIntervalMs: number;
	#emitTimer: ReturnType<typeof setTimeout> | undefined;
	#current: StudioBtwRecord | undefined;
	#store: BtwHistoryStore | undefined;
	#storeSession: string | undefined;
	#storePromise: Promise<BtwHistoryStore> | undefined;
	#writes: Promise<void> = Promise.resolve();
	#saveError: Error | undefined;
	#lastSaved: BtwHistoryRecord | undefined;
	#runs = new Set<Promise<void>>();
	#lineages = new Map<string, string>();

	constructor(
		private readonly session: StudioBtwSessionPort,
		options: StudioBtwServiceOptions = {},
	) {
		this.#idGenerator = options.idGenerator ?? randomUUID;
		this.#tokenGenerator = options.tokenGenerator ?? randomUUID;
		this.#maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
		this.#coalesceIntervalMs = options.coalesceIntervalMs ?? CONVERSATION_LIVE_COALESCE_INTERVAL_MS;
		if (!Number.isSafeInteger(this.#maxTextBytes) || this.#maxTextBytes < 1) {
			throw new RangeError("BTW text limit must be a positive integer");
		}
		if (!Number.isSafeInteger(this.#coalesceIntervalMs) || this.#coalesceIntervalMs < 0) {
			throw new RangeError("BTW coalesce interval must be a non-negative integer");
		}
	}

	async #historyStore(): Promise<BtwHistoryStore> {
		const sessionId = this.session.sessionManager.getSessionId();
		if (this.#storeSession === sessionId && this.#storePromise) return this.#storePromise;
		await this.flush();
		this.#storeSession = sessionId;
		this.#lineages.clear();
		this.#storePromise = BtwHistoryStore.open(this.session.sessionManager.getArtifactsDir?.() ?? undefined);
		try {
			this.#store = await this.#storePromise;
		} catch (error) {
			this.#storePromise = undefined;
			this.#store = undefined;
			this.#saveError = error instanceof Error ? error : new Error("History storage unavailable");
			throw this.#saveError;
		}
		return this.#store;
	}

	async historyList(): Promise<{ sessionId: string; topics: BtwTopicSummary[] }> {
		const store = await this.#historyStore();
		await this.flush();
		return {
			sessionId: this.session.sessionManager.getSessionId(),
			topics: [...store.getRecords()]
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 100)
				.map(record => {
					const turns = getBtwTurns(record);
					return {
						topicId: record.id,
						question: record.question.slice(0, 512),
						updatedAt: record.updatedAt,
						status: turns[turns.length - 1]?.status ?? record.status,
						turnCount: turns.length,
					};
				}),
		};
	}

	async historyRead(topicId: string) {
		const store = await this.#historyStore();
		await this.flush();
		const record = store.getRecords().find(record => record.id === topicId);
		if (!record) throw new StudioBtwError("INTERACTION_STALE", "BTW topic is unavailable");
		return {
			sessionId: this.session.sessionManager.getSessionId(),
			topicId,
			turns: getBtwTurns(record).map(turn => ({
				question: turn.question,
				answer: turn.answer,
				status: turn.status,
				createdAt: turn.createdAt,
				updatedAt: turn.updatedAt,
				...(turn.error ? { error: "BTW request failed" } : {}),
			})),
		};
	}

	async followUp(topicId: string, question: string) {
		if (this.#isRunning()) throw new StudioBtwError("BUSY_STREAMING", "A BTW answer is running");
		if (!question.trim() || question.length > 65536)
			throw new StudioBtwError("INVALID_ARGUMENT", "Invalid BTW question");
		const store = await this.#historyStore();
		await this.flush();
		if (this.#isRunning()) throw new StudioBtwError("BUSY_STREAMING", "A BTW answer is running");
		const prior = store.getRecords().find(record => record.id === topicId);
		if (!prior) throw new StudioBtwError("INTERACTION_STALE", "BTW topic is unavailable");
		const turns = getBtwTurns(prior);
		if (turns[turns.length - 1]?.status !== "complete")
			throw new StudioBtwError("COMMAND_BLOCKED", "Only completed topics accept follow-ups");
		if (
			turns.length >= 32 ||
			turns.reduce((sum, t) => sum + Buffer.byteLength(t.answer + t.question, "utf8"), 0) > 512 * 1024
		)
			throw new StudioBtwError("COMMAND_BLOCKED", "Start a new topic: this conversation reached its history limit");
		const history: Message[] = turns.flatMap(turn => [
			{ role: "user" as const, content: turn.question, timestamp: turn.createdAt },
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: turn.answer }],
				api: "openai-completions" as const,
				provider: "btw",
				model: "btw",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: turn.updatedAt,
			},
		]);
		const record: StudioBtwRecord = {
			ephemeralId: this.#idGenerator(),
			topicId,
			prior: structuredClone(prior),
			history,
			createdAt: Date.now(),
			conversationKey: this.#lineages.get(topicId) ?? this.#tokenGenerator(),
			branchToken: "",
			branchConsumed: true,
			question: question.trim(),
			status: "running",
			text: "",
			textBytes: 0,
			abortController: new AbortController(),
			originalSessionId: this.session.sessionManager.getSessionId(),
			originalLeafId: prior.leafId,
		};
		this.#current = record;
		this.#emit(record);
		const run = this.#run(record);
		this.#runs.add(run);
		void run.finally(() => this.#runs.delete(run));
		return { ephemeralId: record.ephemeralId, status: "running" as const };
	}

	#save(record: StudioBtwRecord, suppliedStore?: BtwHistoryStore): Promise<void> {
		const store = suppliedStore ?? this.#store;
		if (!store || this.#storeSession !== record.originalSessionId) return Promise.resolve();
		const turn = {
			question: record.question,
			answer: record.text,
			status:
				record.status === "completed"
					? ("complete" as const)
					: record.status === "aborted"
						? ("cancelled" as const)
						: record.status === "failed"
							? ("error" as const)
							: ("running" as const),
			createdAt: record.createdAt,
			updatedAt: Date.now(),
			...(record.error ? { error: record.error.message } : {}),
		};
		const data: BtwHistoryRecord = record.prior
			? { ...record.prior, updatedAt: turn.updatedAt, followUps: [...(record.prior.followUps ?? []), turn] }
			: { ...turn, id: record.topicId, leafId: record.originalLeafId };
		this.#lastSaved = data;
		this.#writes = this.#writes
			.catch(() => {})
			.then(async () => {
				try {
					await store.upsert(data);
					this.#saveError = undefined;
				} catch (error) {
					this.#saveError = error instanceof Error ? error : new Error("BTW history save failed");
				}
			});
		return this.#writes.then(() => {
			if (this.#saveError)
				throw new StudioBtwError(
					"COMMAND_BLOCKED",
					"BTW history could not be saved; keep this session open and retry",
				);
		});
	}

	async flush(): Promise<void> {
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(
			() => timeout.reject(new StudioBtwError("COMMAND_BLOCKED", "BTW history save timed out")),
			10000,
		);
		const drain = async () => {
			let pending: Promise<void>;
			do {
				pending = this.#writes;
				await pending;
			} while (pending !== this.#writes);
			if (this.#saveError) {
				try {
					if (!this.#store) {
						this.#store = await BtwHistoryStore.open(
							this.session.sessionManager.getArtifactsDir?.() ?? undefined,
						);
						this.#storePromise = Promise.resolve(this.#store);
						this.#storeSession = this.session.sessionManager.getSessionId();
						if (this.#current) await this.#save(this.#current, this.#store);
					} else if (this.#lastSaved) await this.#store.retry(this.#lastSaved);
					this.#saveError = undefined;
				} catch {
					throw new StudioBtwError("COMMAND_BLOCKED", "BTW history could not be saved; copy the answer and retry");
				}
			}
		};
		try {
			await Promise.race([drain(), timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	async settle(): Promise<void> {
		if (this.#isRunning()) this.abort(this.#current!.ephemeralId);
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(
			() => timeout.reject(new StudioBtwError("COMMAND_BLOCKED", "BTW cancellation did not settle")),
			10000,
		);
		try {
			await Promise.race([Promise.all(this.#runs), timeout.promise]);
			await this.flush();
		} finally {
			clearTimeout(timer);
		}
	}

	#isRunning(): boolean {
		return this.#current?.status === "running";
	}
	onChange(listener: (snapshot: StudioBtwSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	ask(question: string): { ephemeralId: string; branchToken: string; status: "running" } {
		if (this.#saveError)
			throw new StudioBtwError(
				"COMMAND_BLOCKED",
				"An unsaved BTW answer must be saved before starting another topic",
			);
		const trimmed = question.trim();
		if (trimmed.length === 0) throw new StudioBtwError("INVALID_ARGUMENT", "BTW question must not be empty");
		if (trimmed.length > 64 * 1024) throw new StudioBtwError("INVALID_ARGUMENT", "BTW question is too long");
		if (this.#isRunning() || this.#runs.size > 0) {
			throw new StudioBtwError("BUSY_STREAMING", "A BTW request is already running");
		}
		const id = this.#idGenerator();
		const record: StudioBtwRecord = {
			topicId: id,
			createdAt: Date.now(),
			conversationKey: this.#tokenGenerator(),
			ephemeralId: id,
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
		const run = this.#run(record);
		this.#runs.add(run);
		void run.finally(() => this.#runs.delete(run));
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
		this.#lineages.delete(record.topicId);
		void this.#save(record).catch(() => {});
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
		if (record.history?.length)
			throw new StudioBtwError("COMMAND_BLOCKED", "Multi-turn topics remain in BTW history");
		await this.flush();
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
			if (result.cancelled) {
				record.branchConsumed = false;
				return { branched: false, reason: "cancelled" };
			}
			return {
				branched: true,
				newSessionId: this.session.sessionManager.getSessionId(),
				newLeafId: this.session.sessionManager.getLeafId(),
			};
		} catch {
			record.branchConsumed = false;
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
		if (this.#isRunning()) this.abort(this.#current!.ephemeralId);
		this.#clearEmitTimer();
		this.#listeners.clear();
	}

	async #run(record: StudioBtwRecord): Promise<void> {
		try {
			const store = await this.#historyStore();
			await this.#save(record, store);
			if (record.abortController.signal.aborted || record.status !== "running") {
				await this.#save(record, store);
				return;
			}
			const result = await this.session.runEphemeralTurn({
				...(record.history ? { history: record.history } : {}),
				conversationKey: record.conversationKey,
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
			this.#lineages.set(record.topicId, record.conversationKey);
			this.#emit(record);
		} catch {
			if (this.#current !== record || record.status === "aborted" || record.error?.code === "OUTPUT_LIMIT") return;
			record.status = "failed";
			record.error = { code: "INTERNAL_ERROR", message: "BTW request failed" };
			this.#emit(record);
		} finally {
			if (record.status !== "running") await this.#save(record).catch(() => {});
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
		this.#scheduleEmit(record);
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
		return {
			sessionId: record.originalSessionId,
			topicId: record.topicId,
			question: record.question,
			ephemeralId: record.ephemeralId,
			status: record.status,
			text: record.text,
			...(copy.length === 0 ? {} : { copy }),
			// A shallow error copy is enough to keep the record unreachable through
			// a snapshot: the payload is a flat code/message pair and `text` is a
			// string. Deep-cloning here duplicated the whole answer a second time.
			...(record.error === undefined ? {} : { error: { ...record.error } }),
		};
	}

	/** Terminal and lifecycle transitions: emit now, dropping any pending frame. */
	#emit(record: StudioBtwRecord): void {
		this.#clearEmitTimer();
		this.#deliver(record);
	}

	/** Streaming transitions: at most one snapshot per coalesce window. */
	#scheduleEmit(record: StudioBtwRecord): void {
		if (this.#emitTimer !== undefined) return;
		this.#emitTimer = setTimeout(() => {
			this.#emitTimer = undefined;
			// A terminal transition that landed inside the window already emitted a
			// newer snapshot; re-emitting the running one would move status backwards.
			if (this.#current !== record || record.status !== "running") return;
			this.#deliver(record);
		}, this.#coalesceIntervalMs);
	}

	#clearEmitTimer(): void {
		if (this.#emitTimer === undefined) return;
		clearTimeout(this.#emitTimer);
		this.#emitTimer = undefined;
	}

	#deliver(record: StudioBtwRecord): void {
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
