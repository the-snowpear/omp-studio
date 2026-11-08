import type { SessionId } from "./ids.js";

export interface TimeTravelSettings {
  readonly enabled: boolean;
  readonly retentionDays: number | null;
  readonly exclusions: readonly string[];
}

export interface TimeTravelPoint {
  readonly id: string;
  readonly leafId: string | null;
  readonly phase: "before" | "after" | "restore-backup";
  readonly createdAt: string;
  readonly fileCount: number;
  readonly changes?: {
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
  };
}

export interface TimeTravelBranch {
  readonly leafId: string;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface TimeTravelEvent {
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly kind: "user" | "assistant" | "tool" | "compaction" | "system";
  readonly title: string;
  readonly detail: string;
}

export interface TimeTravelTimeline {
  readonly sessionId: SessionId;
  readonly activeLeafId: string | null;
  readonly selectedLeafId: string | null;
  readonly branches: readonly TimeTravelBranch[];
  readonly events: readonly TimeTravelEvent[];
  readonly points: readonly TimeTravelPoint[];
  readonly olderCursor?: string;
}

export interface TimeTravelRestorePreview {
  readonly snapshotId: string;
  readonly revision: string;
  readonly changes: readonly {
    readonly path: string;
    readonly kind: "add" | "modify" | "delete";
  }[];
}

export interface TimeTravelRestoreInput {
  readonly sessionId: SessionId;
  readonly leafId: string | null;
  readonly mode: "code" | "conversation" | "both";
  readonly snapshotId?: string;
  readonly expectedRevision?: string;
}

export interface TimeTravelRestoreResult {
  readonly codeRestored: boolean;
  readonly conversationRestored: boolean;
  readonly backupId?: string;
  readonly error?: string;
}
