export interface SessionRestoreInspection {
  targetSessionId: string;
  savedModels: string[];
  status: "available" | "missing-model" | "unconfigured";
  resolvedModel?: string;
  thinking?: string;
  alternatives: Array<{ model: string; label: string }>;
  truncated: boolean;
}
export type SessionRestoreOperation = {
  kind: "session.restore.inspect";
  sessionId: string;
  targetSessionId: string;
};
export interface SessionRestoreResultMap {
  "session.restore.inspect": SessionRestoreInspection;
}
export const SESSION_RESTORE_KINDS = ["session.restore.inspect"] as const;
export function isSessionRestoreKind(
  kind: string,
): kind is SessionRestoreOperation["kind"] {
  return kind === "session.restore.inspect";
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid session restoration data");
  return value as Record<string, unknown>;
}
function text(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error("Invalid restoration text");
}
export function validateSessionRestoreOperation(value: unknown): void {
  const row = record(value, ["kind", "sessionId", "targetSessionId"]);
  if (row.kind !== "session.restore.inspect")
    throw new Error("Unknown restoration command");
  text(row.sessionId);
  text(row.targetSessionId);
}
export function validateSessionRestoreResult(
  _kind: SessionRestoreOperation["kind"],
  value: unknown,
): void {
  const row = record(value, [
    "targetSessionId",
    "savedModels",
    "status",
    "resolvedModel",
    "thinking",
    "alternatives",
    "truncated",
  ]);
  text(row.targetSessionId);
  if (!Array.isArray(row.savedModels) || row.savedModels.length > 16)
    throw new Error("Invalid saved model list");
  row.savedModels.forEach(text);
  if (
    !["available", "missing-model", "unconfigured"].includes(
      row.status as string,
    ) ||
    typeof row.truncated !== "boolean"
  )
    throw new Error("Invalid restoration state");
  if (row.resolvedModel !== undefined) text(row.resolvedModel);
  if (row.thinking !== undefined) text(row.thinking);
  if (!Array.isArray(row.alternatives) || row.alternatives.length > 500)
    throw new Error("Invalid alternative models");
  for (const value of row.alternatives) {
    const model = record(value, ["model", "label"]);
    text(model.model);
    text(model.label);
  }
}
