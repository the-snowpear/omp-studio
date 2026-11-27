import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

/** Same live Bash card as the upstream-update conversation fixture. */
export function previewPtyInputWaits(threadId: string | undefined): NonNullable<OperatorStateSnapshot["ptyInputWaits"]> {
  return threadId === "t1" ? [{ sessionId: "preview-session", toolCallId: "preview-bash-live", command: "npm run typecheck", waiting: true, notify: false }] : [];
}
