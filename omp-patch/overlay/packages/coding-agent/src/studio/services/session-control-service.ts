import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import type { AgentSession } from "../../session/agent-session";
import type { CustomMessage } from "../../session/messages";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { runtimeText } from "../locale";
import manualContinuePrompt from "../../prompts/system/manual-continue.md" with { type: "text" };

/**
 * Presentation-neutral session control surface shared by the Studio Bridge and
 * (future) TUI adapters. It reuses AgentSession public primitives only; it never
 * automates a PTY. Slash-token expansion (skills) happens in the dispatcher
 * and is forwarded here as preludes.
 */
export type SessionControlPrelude = Pick<
	CustomMessage,
	"customType" | "content" | "display" | "details" | "attribution"
>;

export interface SessionControlSession {
	readonly sessionId?: string;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly queuedMessageCount: number;
	readonly sessionFile?: string;
	prompt(
		text: string,
		options?: {
			images?: ImageContent[];
			prependMessages?: CustomMessage[];
			/** Deliver as a hidden `developer` message instead of a visible user turn. */
			synthetic?: boolean;
			/** Mark the prompt as a deliberate operator action (synthetic continues). */
			userInitiated?: boolean;
		},
	): Promise<boolean>;
	steer(text: string, images?: ImageContent[], options?: { prependMessages?: CustomMessage[] }): Promise<void>;
	followUp(text: string, images?: ImageContent[], options?: { prependMessages?: CustomMessage[] }): Promise<void>;
	promptCustomMessage?(
		message: SessionControlPrelude,
		options?: { streamingBehavior?: "steer" | "followUp"; queueOnly?: boolean },
	): Promise<void | boolean>;
	maybeStartTitleGeneration?(text: string): void;
	resetSessionContext(): Promise<{ droppedCount: number } | undefined>;
	retry(): Promise<boolean>;
	/**
	 * `omp --restore`: go on with the turn the previous process left unfinished.
	 * Optional so a narrow test double can omit load recovery.
	 */
	restoreInterruptedTurn?(): Promise<boolean>;
	abort(options?: { reason?: string; preserveQueuedInput?: boolean }): Promise<void>;
	newSession(options?: { drop?: boolean }): Promise<boolean>;
}

/**
 * `core.continue` outcome. `restored` means load recovery had an unfinished turn
 * to go on with; `continue` is the hidden synthetic continue; `none` means there
 * was nothing to resume, so the surface can say so instead of failing silently.
 */
export interface ContinueTurnOutcome {
	readonly started: boolean;
	readonly mode: "restored" | "continue" | "none";
}

export class SessionControlError extends Error {
	constructor(
		readonly code:
			| "BUSY_STREAMING"
			| "BUSY_COMPACTING"
			| "COMMAND_BLOCKED"
			| "CAPABILITY_UNAVAILABLE"
			| "INTERACTION_REQUIRED"
			| "INVALID_ARGUMENT",
		message: string,
		readonly retryable = false,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "SessionControlError";
	}
}

export interface SessionControlHooks {
	/** Apply deferred model/mode/approval preferences before a queued user message. */
	beforeQueuedUserTurn?: () => Promise<void>;
}

interface SessionTransitionState {
	generation: number;
	pending?: { cancelled: boolean; committing: boolean };
}
const sessionTransitions = new WeakMap<object, SessionTransitionState>();
function transitionState(session: object): SessionTransitionState {
	let state = sessionTransitions.get(session);
	if (!state) {
		state = { generation: 0 };
		sessionTransitions.set(session, state);
	}
	return state;
}

/** Capture before asynchronous input preparation; re-check immediately before native admission. */
export function captureStudioSessionInput(session: { readonly sessionId?: string }): () => void {
	const state = transitionState(session);
	const generation = state.generation;
	const owner = session.sessionId;
	const check = () => {
		if (state.pending || state.generation !== generation || session.sessionId !== owner)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				runtimeText(
					"准备输入时会话已改变；输入未发送。",
					"The session changed while preparing input; the input was not sent",
				),
				true,
			);
	};
	check();
	return check;
}

export function cancelStudioSessionTransition(session: object): void {
	const pending = sessionTransitions.get(session)?.pending;
	if (pending && !pending.committing) pending.cancelled = true;
}

/**
 * One native AgentSession, one lifecycle boundary. Withdrawing/holding native
 * input groups preserves their original session identities; neither failure
 * nor cancellation automatically replays them into a new conversation.
 */
export async function withStudioSessionTransition<T>(
	session: AgentSession,
	transition: () => Promise<T>,
	beforeTransition?: () => Promise<void>,
): Promise<T> {
	const state = transitionState(session);
	if (state.pending)
		throw new SessionControlError(
			"COMMAND_BLOCKED",
			runtimeText("已有会话切换正在进行。", "A session transition is already running"),
			true,
		);
	const pending = { cancelled: false, committing: false };
	const owner = session.sessionId;
	const barrier = crypto.randomUUID();
	state.generation++;
	state.pending = pending;
	const current = () => {
		if (pending.cancelled || session.isDisposed || session.sessionId !== owner)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				runtimeText("会话切换已取消或已被新的操作替代。", "The session transition was cancelled or superseded"),
				true,
			);
	};
	try {
		// abort cancels the old compaction barrier synchronously. Install ours
		// before its first await so later native follow-ups cannot start a turn.
		const aborted = session.abort({ reason: USER_INTERRUPT_LABEL, preserveQueuedInput: true });
		session.beginStudioQueueBarrier(barrier, () => {
			if (!pending.committing) pending.cancelled = true;
		});
		await aborted;
		await session.waitForIdle();
		current();
		await beforeTransition?.();
		current();
		session.clearQueue({ forInterrupt: true, preserveGroups: true });
		pending.committing = true;
		return await transition();
	} finally {
		session.releaseStudioQueueBarrier(barrier, false);
		state.pending = undefined;
		state.generation++;
	}
}

/** Pixel bound the upstream `:img` read selector applies to SVG rasterization. */
const SVG_IMAGE_MAX_EDGE_PX = 2048;

/** Shared session control service. One instance per AgentSession. */
export class SessionControlService {
	readonly #session: SessionControlSession;
	readonly #beforeQueuedUserTurn: (() => Promise<void>) | undefined;

	constructor(session: SessionControlSession, hooks: SessionControlHooks = {}) {
		this.#session = session;
		this.#beforeQueuedUserTurn = hooks.beforeQueuedUserTurn;
	}

	/**
	 * SVG attachments rasterize to PNG before the model call: Bun.Image cannot
	 * decode SVG, so an untouched `image/svg+xml` block would be forwarded as-is
	 * and rejected by the provider. Mirrors the upstream `:img` read selector,
	 * including its pixel bound.
	 */
	async #prepareImages(images: readonly unknown[] | undefined): Promise<ImageContent[] | undefined> {
		if (images === undefined || images.length === 0) return undefined;
		const prepared: ImageContent[] = [];
		for (const entry of images) {
			const image = entry as { mimeType?: unknown };
			prepared.push(image?.mimeType === "image/svg+xml" ? await this.#rasterizeSvg(entry) : (entry as ImageContent));
		}
		return prepared;
	}

	async #rasterizeSvg(entry: unknown): Promise<ImageContent> {
		const image = entry as { type?: unknown; mimeType?: unknown; data?: unknown };
		if (typeof image.data !== "string" || image.data.length === 0) {
			throw new SessionControlError("INVALID_ARGUMENT", "SVG attachment is missing image data");
		}
		let png: Uint8Array;
		try {
			png = await rasterizeSvg(Buffer.from(image.data, "base64"), SVG_IMAGE_MAX_EDGE_PX, SVG_IMAGE_MAX_EDGE_PX);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new SessionControlError("INVALID_ARGUMENT", `Could not rasterize the SVG attachment: ${message}`);
		}
		return {
			type: "image",
			data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64"),
			mimeType: "image/png",
		};
	}

	/**
	 * WP-021 queue.enqueue: queue a user message processed after the current
	 * turn would otherwise stop. Reuses AgentSession.followUp.
	 */
	async enqueue(text: string): Promise<{ queued: true; pendingMessages: number }> {
		captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("queue a message");
		this.#maybeStartTitleGeneration(text);
		await this.#session.followUp(text);
		return { queued: true, pendingMessages: this.#session.queuedMessageCount };
	}

	/**
	 * WP-022 session.clearContext: in-place conversation reset. Refuses while
	 * streaming or compacting; the primitive itself also refuses while a
	 * foreground bash/python execution is in flight.
	 */
	async clearContext(): Promise<{ droppedCount: number }> {
		captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("clear the session context");
		if (this.#session.isStreaming) {
			throw new SessionControlError("BUSY_STREAMING", "Cannot clear context while a response is streaming");
		}
		const result = await this.#session.resetSessionContext();
		if (result === undefined) {
			throw new SessionControlError("COMMAND_BLOCKED", "Session is busy", false, { reason: "SESSION_BUSY" });
		}
		return result;
	}

	/** WP-023 session.drop: execute only after Runtime-side InteractionPort approval. */
	async drop(approved: boolean): Promise<{ dropped: boolean; reason?: "cancelled" | "nothing_to_drop" }> {
		captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("drop the session");
		if (this.#session.isStreaming) {
			throw new SessionControlError("BUSY_STREAMING", "Cannot drop a session while a response is streaming");
		}
		if (!approved) return { dropped: false, reason: "cancelled" };
		if (this.#session.sessionFile === undefined) return { dropped: false, reason: "nothing_to_drop" };
		const dropped = await this.#session.newSession({ drop: true });
		return dropped ? { dropped: true } : { dropped: false, reason: "cancelled" };
	}

	/**
	 * WP-024 turn.retry: retry the last failed assistant turn when idle.
	 * `nothing_to_retry` is an explicit, non-error result.
	 */
	async retry(): Promise<{ retried: boolean; reason?: "nothing_to_retry" }> {
		captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("retry the last failed turn");
		if (this.#session.isStreaming) {
			throw new SessionControlError("BUSY_STREAMING", "Cannot retry while a response is streaming");
		}
		const retried = await this.#session.retry();
		if (!retried) return { retried: false, reason: "nothing_to_retry" };
		return { retried: true };
	}

	/**
	 * `core.continue`: resume the turn that stopped without a final report.
	 *
	 * A turn the previous process left unfinished is handed to `restoreInterruptedTurn`,
	 * which closes its unresolved tool calls and retries it the way `omp --restore` does.
	 * Everything else takes the hidden synthetic continue the TUI's `c` / `.` sends: the
	 * model keeps the partial answer and goes on, and nothing is written as a visible user
	 * message. `interrupted: false` is the caller's tail reading — the guard that keeps a
	 * stale surface from turning a finished conversation into a fresh model call.
	 */
	async continueTurn(input: { readonly interrupted: boolean }): Promise<ContinueTurnOutcome> {
		const checkOwner = captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("continue the interrupted turn");
		if (this.#session.isStreaming) {
			throw new SessionControlError("BUSY_STREAMING", "Cannot continue while a response is streaming");
		}
		if (input.interrupted && (await this.#session.restoreInterruptedTurn?.()) === true) {
			return { started: true, mode: "restored" };
		}
		if (!input.interrupted) return { started: false, mode: "none" };
		checkOwner();
		const started = await this.#session.prompt(manualContinuePrompt, { synthetic: true, userInitiated: true });
		return started ? { started: true, mode: "continue" } : { started: false, mode: "none" };
	}

	/**
	 * WP-025 core.prompt: send a fresh prompt. While streaming — or when a
	 * background turn flips the agent busy between the isStreaming check and
	 * prompt() (queued-message drain, idle compaction, goal/loop timers) — the
	 * prompt degrades to a queued followUp instead of failing, so a
	 * queued-message flush can never lose the message; use core.steer to
	 * interrupt instead.
	 */
	async prompt(
		text: string,
		images?: readonly unknown[],
		preludes?: readonly CustomMessage[],
	): Promise<{ started: boolean }> {
		const checkOwner = captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("send a prompt");
		if (this.#session.isStreaming) {
			await this.followUp(text, images, preludes);
			return { started: false };
		}
		this.#maybeStartTitleGeneration(text);
		try {
			const preparedImages = await this.#prepareImages(images);
			checkOwner();
			const started = await this.#session.prompt(text, {
				images: preparedImages,
				...(preludes !== undefined && preludes.length > 0 ? { prependMessages: [...preludes] } : {}),
			});
			return { started };
		} catch (error) {
			if (error instanceof AgentBusyError) {
				checkOwner();
				await this.followUp(text, images, preludes);
				return { started: false };
			}
			throw this.#mapBusy(error);
		}
	}

	/** WP-025 core.steer: queue a steering message interrupting the current run. */
	async steer(
		text: string,
		images?: readonly unknown[],
		preludes?: readonly SessionControlPrelude[],
	): Promise<{ queued: true; pendingMessages: number }> {
		const checkOwner = captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("steer the session");
		this.#maybeStartTitleGeneration(text);
		try {
			await this.#beforeQueuedUserTurn?.();
			const preparedImages = await this.#prepareImages(images);
			checkOwner();
			await this.#session.steer(
				text,
				preparedImages,
				preludes?.length
					? {
							prependMessages: preludes.map(prelude => ({
								role: "custom" as const,
								timestamp: Date.now(),
								...prelude,
							})),
						}
					: undefined,
			);
		} catch (error) {
			throw this.#mapBusy(error);
		}
		return { queued: true, pendingMessages: this.#session.queuedMessageCount };
	}

	/** WP-025 core.followUp: queue a follow-up message processed after the current turn. */
	async followUp(
		text: string,
		images?: readonly unknown[],
		preludes?: readonly SessionControlPrelude[],
	): Promise<{ queued: true; pendingMessages: number }> {
		const checkOwner = captureStudioSessionInput(this.#session);
		this.#assertNotCompacting("queue a follow-up");
		this.#maybeStartTitleGeneration(text);
		try {
			if (!this.#session.isStreaming) await this.#beforeQueuedUserTurn?.();
			const preparedImages = await this.#prepareImages(images);
			checkOwner();
			await this.#session.followUp(
				text,
				preparedImages,
				preludes?.length
					? {
							prependMessages: preludes.map(prelude => ({
								role: "custom" as const,
								timestamp: Date.now(),
								...prelude,
							})),
						}
					: undefined,
			);
		} catch (error) {
			throw this.#mapBusy(error);
		}
		return { queued: true, pendingMessages: this.#session.queuedMessageCount };
	}

	/** WP-025 core.abort: abort the current operation and wait until idle.
	 *  During a manual compaction this cancels the compaction instead of being
	 *  refused — the GUI cancel button and native Esc share the semantics:
	 *  `session.abort` → `abortCompaction`, then waits for its cleanup barrier. */
	async abort(): Promise<{ aborted: true }> {
		cancelStudioSessionTransition(this.#session);
		try {
			await this.#session.abort({ reason: USER_INTERRUPT_LABEL, preserveQueuedInput: true });
		} catch (error) {
			throw this.#mapBusy(error);
		}
		return { aborted: true };
	}

	#maybeStartTitleGeneration(text: string): void {
		this.#session.maybeStartTitleGeneration?.(text);
	}

	#assertNotCompacting(activity: string): void {
		if (this.#session.isCompacting) {
			throw new SessionControlError("BUSY_COMPACTING", `Cannot ${activity} while the session is compacting`);
		}
	}

	#mapBusy(error: unknown): SessionControlError {
		if (error instanceof AgentBusyError) {
			return new SessionControlError("BUSY_STREAMING", "Agent is busy streaming");
		}
		throw error;
	}
}
