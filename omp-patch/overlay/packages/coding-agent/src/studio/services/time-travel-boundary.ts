import { randomUUID } from "node:crypto";
import type { AgentSession } from "../../session/agent-session";

export interface TimeTravelCaptureRequest {
	type: "timeTravel.capture.request";
	requestId: string;
	runtimeEpoch: number;
	sessionId: string;
	cwd: string;
	leafId: string | null;
	phase: "before" | "after";
}

/** Captures only at awaited turn boundaries; queued user messages start a new boundary. */
export class StudioTimeTravelBoundary {
	#listener: ((request: TimeTravelCaptureRequest) => void) | undefined;
	#pending = new Map<string, (error?: string) => void>();
	#tail: Promise<void> = Promise.resolve();
	#open: { sessionId: string; leafId: string | null } | undefined;

	constructor(
		private readonly session: AgentSession,
		private readonly runtimeEpoch: number,
	) {}

	subscribe(listener: (request: TimeTravelCaptureRequest) => void): () => void {
		this.#listener = listener;
		return () => {
			if (this.#listener === listener) this.#listener = undefined;
		};
	}

	complete(requestId: string, error?: string): void {
		this.#pending.get(requestId)?.(error);
	}

	capture(phase: "before" | "after"): Promise<void> {
		if (!this.#listener) return Promise.resolve();
		const sessionId = this.session.sessionManager.getSessionId();
		const leafId = this.session.sessionManager.getLeafId();
		const cwd = this.session.sessionManager.getCwd();
		const next = this.#tail.then(async () => {
			if (phase === "after" && this.#open?.sessionId !== sessionId) return;
			// A queued drain may enter through both the session and core queue hooks.
			if (phase === "before" && this.#open?.sessionId === sessionId && this.#open.leafId === leafId) return;
			await this.session.sessionManager.flush();
			if (phase === "before" && this.#open?.sessionId === sessionId) {
				await this.#send({
					type: "timeTravel.capture.request",
					requestId: randomUUID(),
					runtimeEpoch: this.runtimeEpoch,
					sessionId,
					cwd,
					leafId,
					phase: "after",
				});
			}
			this.#open = phase === "before" ? { sessionId, leafId } : undefined;
			await this.#send({
				type: "timeTravel.capture.request",
				requestId: randomUUID(),
				runtimeEpoch: this.runtimeEpoch,
				sessionId,
				cwd,
				leafId,
				phase,
			});
		});
		this.#tail = next.catch(error =>
			this.session.emitNotice(
				"warning",
				`Time Travel: ${error instanceof Error ? error.message : String(error)}`,
				"time-travel",
			),
		);
		return this.#tail;
	}

	async #send(request: TimeTravelCaptureRequest): Promise<void> {
		const listener = this.#listener;
		if (!listener) return;
		// A timeout must not release the next turn while the Host is still reading its files.
		const error = await new Promise<string | undefined>(resolve => {
			const finish = (message?: string) => {
				this.#pending.delete(request.requestId);
				resolve(message);
			};
			this.#pending.set(request.requestId, finish);
			try {
				listener(request);
			} catch (cause) {
				finish(cause instanceof Error ? cause.message : String(cause));
			}
		});
		if (error) this.session.emitNotice("warning", `Time Travel: ${error}`, "time-travel");
	}

	dispose(): void {
		this.#listener = undefined;
		this.disconnect();
	}
	disconnect(): void {
		for (const finish of this.#pending.values()) finish("Snapshot connection closed");
	}
}
