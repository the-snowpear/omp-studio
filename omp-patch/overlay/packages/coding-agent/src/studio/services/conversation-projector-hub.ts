import type { AgentRef, AgentRegistry, RegistryEvent } from "../../registry/agent-registry";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { ConversationRuntimeEvent } from "../conversation-protocol";
import type { ConversationLiveBindTarget, ConversationLiveProjector } from "./conversation-live-projector";

type LiveListener = (event: ConversationRuntimeEvent) => void;

export type ConversationChildProjectorFactory = (ref: AgentRef) => ConversationLiveProjector | undefined;

type BoundChild = {
	session: AgentSession;
	projector: ConversationLiveProjector;
	unsubscribe: () => void;
};

/**
 * Fans main and child ConversationLiveProjector events into one onEvent surface.
 * StateProjector still owns eventSeq / stateVersion envelopes.
 */
export class ConversationProjectorHub {
	readonly #main: ConversationLiveProjector;
	readonly #registry: AgentRegistry;
	readonly #createChild: ConversationChildProjectorFactory;
	readonly #runtimeEpoch: () => number;
	readonly #listeners = new Set<LiveListener>();
	readonly #children = new Map<string, BoundChild>();
	readonly #unsubscribeRegistry: () => void;
	readonly #unsubscribeMain: () => void;
	#disposed = false;

	constructor(options: {
		main: ConversationLiveProjector;
		registry: AgentRegistry;
		createChild: ConversationChildProjectorFactory;
		runtimeEpoch: () => number;
	}) {
		this.#main = options.main;
		this.#registry = options.registry;
		this.#createChild = options.createChild;
		this.#runtimeEpoch = options.runtimeEpoch;
		this.#unsubscribeMain = this.#main.onEvent(event => this.#fanout(event));
		this.#unsubscribeRegistry = this.#registry.onChange(event => this.#onRegistry(event));
		this.reconcile();
	}

	onEvent(listener: LiveListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	bind(target: ConversationLiveBindTarget): void {
		this.#main.bind(target);
	}

	reconcile(): void {
		if (this.#disposed) return;
		const live = new Set<string>();
		for (const ref of this.#registry.list()) {
			if (!this.#shouldBind(ref)) continue;
			live.add(ref.id);
			this.#bind(ref);
		}
		for (const agentId of [...this.#children.keys()]) {
			if (!live.has(agentId)) this.#unbind(agentId);
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeRegistry();
		this.#unsubscribeMain();
		for (const agentId of [...this.#children.keys()]) this.#unbind(agentId);
		this.#main.dispose();
		this.#listeners.clear();
	}

	#shouldBind(ref: AgentRef): boolean {
		return ref.id !== MAIN_AGENT_ID && ref.kind === "sub" && ref.session !== null;
	}

	#onRegistry(event: RegistryEvent): void {
		if (this.#disposed) return;
		if (event.type === "removed") {
			this.#unbind(event.ref.id);
			return;
		}
		if (event.type === "registered" || event.type === "session_changed" || event.type === "status_changed") {
			if (this.#shouldBind(event.ref)) this.#bind(event.ref);
			else this.#unbind(event.ref.id);
		}
	}

	#bind(ref: AgentRef): void {
		if (this.#disposed || !this.#shouldBind(ref) || ref.session === null) return;
		const existing = this.#children.get(ref.id);
		const session = ref.session;
		const sessionId = session.sessionManager.getSessionId();
		if (existing !== undefined && existing.session === session) {
			if (existing.projector.sessionId !== sessionId) {
				existing.projector.rebind(session, {
					sessionId,
					runtimeEpoch: this.#runtimeEpoch(),
				});
			}
			return;
		}
		if (existing !== undefined) this.#unbind(ref.id);
		const projector = this.#createChild(ref);
		if (projector === undefined) return;
		const unsubscribe = projector.onEvent(event => this.#fanout(event));
		this.#children.set(ref.id, { session, projector, unsubscribe });
	}

	#unbind(agentId: string): void {
		const existing = this.#children.get(agentId);
		if (existing === undefined) return;
		this.#children.delete(agentId);
		existing.unsubscribe();
		existing.projector.flush();
		existing.projector.dispose();
	}

	#fanout(event: ConversationRuntimeEvent): void {
		if (this.#disposed) return;
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch {
				// listeners must not break the projector loop
			}
		}
	}
}
