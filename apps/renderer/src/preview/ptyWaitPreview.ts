import type { JobInspection, OperatorStateSnapshot } from "@omp-studio/studio-protocol";

/** Same live Bash card as the upstream-update conversation fixture. */
export function previewPtyInputWaits(threadId: string | undefined): NonNullable<OperatorStateSnapshot["ptyInputWaits"]> {
  return threadId === "t1" ? [{ sessionId: "preview-session", sourceSessionId: "preview-session", jobId: "preview-pty", jobGeneration: 1, toolCallId: "preview-bash-live", command: "npm run typecheck", waiting: true, notify: false }] : [];
}

export function previewPtyInspection(jobId: string, generation = 1): JobInspection {
  return { jobId, pids: [], command: "npm run typecheck", canInput: true, inputGeneration: generation, waitingForInput: true, output: "Continue? [y/N]" };
}
