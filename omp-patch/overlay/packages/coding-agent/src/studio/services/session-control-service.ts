import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import type { CustomMessage } from "../../session/messages";
import { USER_INTERRUPT_LABEL } from "../../session/messages";

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
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly queuedMessageCount: number;
	readonly sessionFile?: string;
	prompt(text: string, options?: { images?: ImageContent[]; prependMessages?: CustomMessage[] }): Promise<boolean>;
	steer(text: string, images?: ImageContent[]): Promise<void>;
	followUp(text: string, images?: ImageContent[]): Promise<void>;
	promptCustomMessage?(
		message: SessionControlPrelude,
		options?: { streamingBehavior?: "steer" | "followUp"; queueOnly?: boolean },
	): Promise<void>;
	maybeStartTitleGeneration?(text: string): void;
	resetSessionContext(): Promise<{ droppedCount: number } | undefined>;
	retry(): Promise<boolean>;
	abort(options?: { reason?: string }): Promise<void>;
	newSession(options?: { drop?: boolean }): Promise<boolean>;
}

export class SessionControlError extends Error {
	constructor(
		readonly code:
			| "BUSY_STREAMING"
			| "BUSY_COMPACTING"
			| "COMMAND_BLOCKED"
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
		this.#assertNotCompacting("retry the last failed turn");
		if (this.#session.isStreaming) {
			throw new SessionControlError("BUSY_STREAMING", "Cannot retry while a response is streaming");
		}
		const retried = await this.#session.retry();
		if (!retried) return { retried: false, reason: "nothing_to_retry" };
		return { retried: true };
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
		this.#assertNotCompacting("send a prompt");
		if (this.#session.isStreaming) {
			await this.followUp(text, images, preludes);
			return { started: false };
		}
		this.#maybeStartTitleGeneration(text);
		try {
			const started = await this.#session.prompt(text, {
				images: await this.#prepareImages(images),
				...(preludes !== undefined && preludes.length > 0 ? { prependMessages: [...preludes] } : {}),
			});
			return { started };
		} catch (error) {
			if (error instanceof AgentBusyError) {
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
		this.#assertNotCompacting("steer the session");
		this.#maybeStartTitleGeneration(text);
		try {
			await this.#beforeQueuedUserTurn?.();
			await this.#queuePreludes(preludes, "steer");
			await this.#session.steer(text, await this.#prepareImages(images));
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
		this.#assertNotCompacting("queue a follow-up");
		this.#maybeStartTitleGeneration(text);
		try {
			if (!this.#session.isStreaming) await this.#beforeQueuedUserTurn?.();
			await this.#queuePreludes(preludes, "followUp");
			await this.#session.followUp(text, await this.#prepareImages(images));
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
		try {
			await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
		} catch (error) {
			throw this.#mapBusy(error);
		}
		return { aborted: true };
	}

	async #queuePreludes(
		preludes: readonly SessionControlPrelude[] | undefined,
		streamingBehavior: "steer" | "followUp",
	): Promise<void> {
		if (preludes === undefined || preludes.length === 0) return;
		if (this.#session.promptCustomMessage === undefined) {
			throw new SessionControlError("COMMAND_BLOCKED", "Session cannot inject skill preludes");
		}
		for (const prelude of preludes) {
			await this.#session.promptCustomMessage(prelude, { streamingBehavior, queueOnly: true });
		}
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
