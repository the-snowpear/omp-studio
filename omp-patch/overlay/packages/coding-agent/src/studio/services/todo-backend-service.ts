import type { AgentSession } from "../../session/agent-session";
import { cfgTodoBackend, NATIVE_TODO_BACKEND } from "../../tools/settings";
import type { TodoBackendOperation, TodoBackendState } from "../todo-backend-protocol";
import { runtimeText } from "../locale";
import { SessionControlError } from "./session-control-service";

export class StudioTodoBackendService {
	constructor(readonly session: AgentSession) {}

	#state(): TodoBackendState {
		const selected = cfgTodoBackend.get(this.session.settings);
		const runner = this.session.extensionRunner;
		const registered = runner?.getTodoBackends() ?? new Map();
		const native = selected === NATIVE_TODO_BACKEND;
		const sync = runner?.getTodoBackendStatus();
		return {
			selected,
			source: cfgTodoBackend.provenance(this.session.settings),
			backends: [
				{ id: NATIVE_TODO_BACKEND, label: runtimeText("原生会话列表", "Native session list") },
				...Array.from(registered, ([id, { definition, extension }]) => ({
					id,
					label: definition.label ?? id,
					...(definition.description ? { description: definition.description } : {}),
					extensionPath: extension.path,
				})),
			],
			sync: native
				? { state: "native" }
				: !registered.has(selected)
					? { state: "unavailable" }
					: sync?.backend === selected
						? { state: sync.state, updatedAt: sync.updatedAt }
						: { state: "idle" },
		};
	}

	async execute(op: TodoBackendOperation): Promise<TodoBackendState> {
		if (op.sessionId !== this.session.sessionId)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				runtimeText("活动会话已改变，请重新读取 Todo 后端", "The active session changed; reload Todo backends"),
			);
		if (this.session.hasPendingDeferredExtensions) await this.session.loadDeferredExtensions();
		if (op.kind === "todo.backends.get") return this.#state();
		if (op.kind === "todo.backend.set") {
			if (op.backend !== NATIVE_TODO_BACKEND && !this.session.extensionRunner?.getTodoBackends().has(op.backend))
				throw new SessionControlError(
					"INVALID_ARGUMENT",
					runtimeText("当前会话没有注册该 Todo 后端", "This session has not registered that Todo backend"),
				);
			if (op.scope === "session") cfgTodoBackend.override(this.session.settings, op.backend);
			else {
				cfgTodoBackend.set(this.session.settings, op.backend);
				await this.session.settings.flush();
			}
		}
		const selected = cfgTodoBackend.get(this.session.settings);
		if (selected !== NATIVE_TODO_BACKEND)
			this.session.extensionRunner?.syncTodoBackend(selected, this.session.getTodoPhases());
		return this.#state();
	}
}
