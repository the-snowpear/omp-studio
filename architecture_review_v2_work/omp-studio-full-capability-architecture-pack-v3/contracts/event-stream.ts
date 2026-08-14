export interface EventCursor {
  hostEpoch: string;
  seq: number;
}

export interface StudioEvent<T = unknown> extends EventCursor {
  eventId: string;
  timestamp: number;
  runtimeEpoch?: string;
  projectId?: string;
  threadId?: string;
  commandId?: string;
  runId?: string;
  type: string;
  payload: T;
}

export interface ProjectionSnapshot<T = unknown> {
  hostEpoch: string;
  snapshotSeq: number;
  projectionRevision: number;
  runtimeEpochByThread: Record<string, string | null>;
  generatedAt: number;
  projection: T;
}

export type ResumeRequest = { hostEpoch: string; afterSeq: number };

export type ResumeResult<T = unknown> =
  | { type: "replay"; fromSeq: number; events: StudioEvent[] }
  | { type: "snapshot"; snapshot: ProjectionSnapshot<T>; bufferedEvents: StudioEvent[] }
  | { type: "resync_required"; reason: "epoch_mismatch" | "cursor_ahead" | "journal_gap" };

/**
 * hostEpoch changes on every Host start. seq is Host-global and strictly
 * increasing only within a hostEpoch. runtimeEpoch changes for every OMP
 * process. Snapshot publication is atomic: register/buffer events, capture the
 * projection through S, then deliver only events with seq > S. Clients dedupe
 * by (hostEpoch, seq) and must never combine snapshots across hostEpoch values.
 */
