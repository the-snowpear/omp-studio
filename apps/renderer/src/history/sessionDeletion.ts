import type { SessionHistoryEntry, ThreadId } from "@omp-studio/client-contract";

export type ArchivedDeleteOutcome =
  | { readonly threadId: ThreadId; readonly status: "deleted"; readonly cleanupWarning?: string }
  | { readonly threadId: ThreadId; readonly status: "failed"; readonly reason: string };

export type DeleteArchivedSessions = (
  entries: readonly SessionHistoryEntry[],
  onProgress: (processed: number) => void,
) => Promise<readonly ArchivedDeleteOutcome[]>;
