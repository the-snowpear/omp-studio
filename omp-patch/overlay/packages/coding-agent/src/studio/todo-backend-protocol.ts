export interface TodoBackendOption {
	id: string;
	label: string;
	description?: string;
	extensionPath?: string;
}
export interface TodoBackendState {
	selected: string;
	source: "env" | "runtime" | "overlay" | "project" | "global" | "default";
	backends: TodoBackendOption[];
	sync: { state: "native" | "unavailable" | "idle" | "queued" | "syncing" | "synced" | "failed"; updatedAt?: number };
}
export type TodoBackendOperation =
	| { kind: "todo.backends.get"; sessionId: string }
	| { kind: "todo.backend.set"; sessionId: string; backend: string; scope: "global" | "session" }
	| { kind: "todo.backend.sync"; sessionId: string };
export interface TodoBackendResultMap {
	"todo.backends.get": TodoBackendState;
	"todo.backend.set": TodoBackendState;
	"todo.backend.sync": TodoBackendState;
}
export const TODO_BACKEND_KINDS = ["todo.backends.get", "todo.backend.set", "todo.backend.sync"] as const;
export const TODO_BACKEND_READ_KINDS = ["todo.backends.get"] as const;
export function isTodoBackendKind(kind: string): kind is TodoBackendOperation["kind"] {
	return (TODO_BACKEND_KINDS as readonly string[]).includes(kind);
}

export function validateTodoBackendOperation(value: unknown): asserts value is TodoBackendOperation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid todo backend operation");
	const op = value as Record<string, unknown>;
	if (typeof op.kind !== "string" || !isTodoBackendKind(op.kind)) throw new Error("Unknown todo backend operation");
	if (typeof op.sessionId !== "string" || !op.sessionId || op.sessionId.length > 512)
		throw new Error("Invalid session id");
	if (op.kind === "todo.backend.set") {
		if (typeof op.backend !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(op.backend))
			throw new Error("Invalid todo backend id");
		if (op.scope !== "global" && op.scope !== "session") throw new Error("Invalid todo backend scope");
	}
}
