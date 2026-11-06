import type { ComputerControlState } from "../computer-workspace-protocol";
import type { ComputerRunPermit } from "../computer-runtime-lifecycle";
import { SessionControlError } from "./session-control-service";

export interface ComputerContinueIntent {
	nonce: string;
	revision: number;
	sessionId: string;
}
export interface ComputerControlPort {
	persist(state: ComputerControlState): Promise<void>;
	cancel(): Promise<void>;
	changed(): void;
}
/** One root's persistent stop latch. A new permit never revives the old aborted signal. */
export class ComputerControlPolicy {
	#state: ComputerControlState;
	#gate = new AbortController();
	#stop?: Promise<ComputerControlState>;
	#resume?: Promise<void>;
	#intent?: ComputerContinueIntent;
	readonly #staleInputs = new Set<string>();
	constructor(
		readonly sessionId: string,
		readonly port: ComputerControlPort,
		restored?: ComputerControlState,
	) {
		this.#state = restored
			? { ...restored, foreground: "none" }
			: { status: "allowed", revision: 0, updatedAt: Date.now(), foreground: "none" };
		if (this.#state.status !== "allowed") {
			this.#state.status = this.#state.status === "stopped" ? "stopped" : "unconfirmed";
			this.#gate.abort();
		}
	}
	get state(): ComputerControlState {
		return { ...this.#state };
	}
	setForeground(foreground: ComputerControlState["foreground"]): void {
		this.#state.foreground = foreground;
		this.port.changed();
	}
	async authorize(sessionId = this.sessionId): Promise<ComputerRunPermit> {
		await this.#resume;
		if (this.#state.status !== "allowed" || this.#staleInputs.has(sessionId))
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Computer operations are stopped. Submit a new explicit continue request for the current stop revision.",
			);
		return { signal: this.#gate.signal, revision: this.#state.revision };
	}
	stop(reason = "stop"): Promise<ComputerControlState> {
		if (this.#stop) return this.#stop;
		if (this.#state.status === "stopped") return Promise.resolve(this.state);
		// This must happen before the first await or persistence call.
		this.#gate.abort(new Error("Computer operations stopped by the user"));
		this.#intent = undefined;
		this.#state = {
			status: "stopping",
			revision: this.#state.revision + 1,
			updatedAt: Date.now(),
			foreground: this.#state.foreground,
			reason,
		};
		this.port.changed();
		const revision = this.#state.revision;
		const finish = async (): Promise<ComputerControlState> => {
			try {
				await Promise.all([this.port.persist(this.state), this.port.cancel()]);
				if (revision !== this.#state.revision) throw new Error("Computer stop revision changed");
				this.#state = { ...this.#state, status: "stopped", foreground: "none", updatedAt: Date.now() };
				await this.port.persist(this.state);
				this.port.changed();
				return this.state;
			} catch (error) {
				this.#state = { ...this.#state, status: "unconfirmed", updatedAt: Date.now() };
				this.port.changed();
				throw error;
			} finally {
				this.#stop = undefined;
			}
		};
		this.#stop = finish();
		return this.#stop;
	}
	prepareContinue(revision: number): { intent: ComputerContinueIntent; fresh: boolean } {
		if (revision !== this.#state.revision)
			throw new SessionControlError("COMMAND_BLOCKED", "This continue request belongs to an older stop revision");
		if (this.#state.status === "stopping" || this.#state.status === "unconfirmed")
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Stop cleanup and persistence must be confirmed before continuing",
			);
		if (this.#intent) return { intent: this.#intent, fresh: false };
		if (this.#state.status === "allowed")
			throw new SessionControlError("COMMAND_BLOCKED", "Computer operations are already allowed");
		const intent = { nonce: crypto.randomUUID(), revision, sessionId: this.sessionId };
		this.#intent = intent;
		this.#state = { ...this.#state, status: "continuing", updatedAt: Date.now() };
		this.port.changed();
		return { intent, fresh: true };
	}
	cancelIntent(nonce: string): void {
		if (this.#intent?.nonce !== nonce || this.#state.status !== "continuing") return;
		this.#intent = undefined;
		this.#state.status = "stopped";
		this.port.changed();
	}
	/** Only the exact visible, user-attributed custom message issued here can consume the nonce. */
	consume(sessionId: string, value: unknown): void {
		if (!value || typeof value !== "object") return;
		const message = value as {
			role?: string;
			customType?: string;
			display?: boolean;
			attribution?: string;
			details?: ComputerContinueIntent;
			timestamp?: number;
			synthetic?: boolean;
		};
		// An input queued before the latest explicit resume cannot borrow the new task's permit.
		// Synthetic continuations do not change this binding; they inherit the task already executing.
		if (
			this.#state.status === "allowed" &&
			this.#state.revision > 0 &&
			message.role === "user" &&
			message.synthetic !== true &&
			message.attribution !== "agent"
		) {
			if (typeof message.timestamp !== "number" || message.timestamp <= this.#state.updatedAt)
				this.#staleInputs.add(sessionId);
			else this.#staleInputs.delete(sessionId);
		}
		const intent = this.#intent;
		if (
			!intent ||
			this.#resume ||
			this.#state.status !== "continuing" ||
			sessionId !== this.sessionId ||
			message.role !== "custom" ||
			message.customType !== "studio-computer-continue" ||
			message.display !== true ||
			message.attribution !== "user" ||
			message.details?.nonce !== intent.nonce ||
			message.details.revision !== this.#state.revision ||
			message.details.sessionId !== this.sessionId
		)
			return;
		const revision = this.#state.revision;
		const resumed = {
			...this.#state,
			status: "allowed" as const,
			foreground: "none" as const,
			updatedAt: Date.now(),
		};
		// Entry has actually reached execution, but new calls still wait until it is durable.
		this.#resume = this.port
			.persist(resumed)
			.then(
				() => {
					if (this.#state.revision !== revision || this.#intent !== intent) return;
					this.#gate = new AbortController();
					this.#staleInputs.delete(sessionId);
					this.#state = resumed;
					this.port.changed();
				},
				() => {
					if (this.#state.revision !== revision) return;
					this.#state.status = "unconfirmed";
					this.port.changed();
				},
			)
			.finally(() => {
				this.#resume = undefined;
			});
	}
	dispose(): void {
		this.#gate.abort();
		this.#intent = undefined;
	}
}
