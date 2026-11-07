import { randomUUID } from "node:crypto";
import type { CompactOptions } from "../../extensibility/extensions/types";
import type { AgentSession } from "../../session/agent-session";
import { continuesConversation, conversationPosition } from "../../modes/utils/conversation-position";
import { waitForCompactionYield, type CompactionSubmissionPort } from "./compaction-yield";
import { SessionControlError } from "./session-control-service";

interface QueuedCompaction {
	id: string;
	sessionId: string;
	leafId: string | null;
	state: "queued" | "running";
	instructions?: string;
	options?: CompactOptions;
}
const owners = new Map<string, StudioQueuedCompactionService>();
export function queuedCompactionForSession(sessionId: string): StudioQueuedCompactionService | undefined {
	return owners.get(sessionId);
}

/** Keeps later prepared groups outside executable queues until the native compaction finishes. */
export class StudioQueuedCompactionService {
	#request: QueuedCompaction | undefined;
	#work: Promise<void> | undefined;
	#submissions: CompactionSubmissionPort | undefined;
	#error: string | undefined;
	#sessionId: string;
	readonly #unsubscribe: () => void;
	constructor(readonly session: AgentSession) {
		this.#sessionId = session.sessionManager.getSessionId();
		owners.set(this.#sessionId, this);
		this.#unsubscribe = session.registerSessionChangeCallback(() => {
			this.cancel(false);
			owners.delete(this.#sessionId);
			this.#sessionId = session.sessionManager.getSessionId();
			owners.set(this.#sessionId, this);
		});
	}
	get running(): boolean {
		return this.#request !== undefined;
	}
	get error(): string | undefined {
		return this.#error;
	}
	setSubmissionPort(port: CompactionSubmissionPort): void {
		this.#submissions = port;
	}
	entry() {
		const request = this.#request;
		return request
			? {
					id: request.id,
					kind: "compaction" as const,
					queue: "followUp" as const,
					state: request.state === "running" ? ("inFlight" as const) : ("queued" as const),
					text: request.instructions ? `压缩上下文 · ${request.instructions}` : "压缩上下文 / Compact context",
					imageCount: 0,
					editable: false,
				}
			: undefined;
	}
	enqueue(instructions?: string, options?: CompactOptions): void {
		if (this.#request) throw new SessionControlError("COMMAND_BLOCKED", "A compaction is already queued");
		const request: QueuedCompaction = {
			...conversationPosition(this.session.sessionManager),
			id: randomUUID(),
			state: "queued",
			instructions,
			options,
		};
		this.#request = request;
		this.#error = undefined;
		this.session.beginStudioQueueBarrier(request.id, () => this.cancel(false, false));
		this.#work = this.#run(request);
	}
	wait(): Promise<void> {
		return this.#work ?? Promise.resolve();
	}
	cancel(restore = true, abortActive = true): void {
		const request = this.#request;
		if (!request) return;
		this.#request = undefined;
		this.session.releaseStudioQueueBarrier(
			request.id,
			restore && continuesConversation(this.session.sessionManager, request),
		);
		if (abortActive && request.state === "running") this.session.abortCompaction();
	}
	async #run(request: QueuedCompaction): Promise<void> {
		const current = () => this.#request === request && continuesConversation(this.session.sessionManager, request);
		try {
			if (!(await waitForCompactionYield(this.session, current, this.#submissions))) return;
			if (this.session.isCompacting) {
				while (this.#request === request && this.session.isCompacting) await Bun.sleep(10);
				return;
			}
			request.state = "running";
			await this.session.compact(request.instructions, request.options);
		} catch (error) {
			if (this.#request === request) this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.session.releaseStudioQueueBarrier(
					request.id,
					continuesConversation(this.session.sessionManager, request),
				);
			}
		}
	}
	dispose(): void {
		this.cancel(false);
		this.#unsubscribe();
		owners.delete(this.#sessionId);
	}
}
