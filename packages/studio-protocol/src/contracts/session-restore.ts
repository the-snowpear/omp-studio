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
