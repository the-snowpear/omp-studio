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
