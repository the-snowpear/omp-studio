export type WorkspaceMode =
  | "canonical"
  | "managed-worktree"
  | "permanent-worktree"
  | "read-only";

export interface WorkspaceBinding {
  workspaceId: string;
  environmentId: string;
  projectId: string;
  canonicalRoot: string;
  workingRoot: string;
  gitCommonDir?: string;
  repositoryIdentity?: string;
  mode: WorkspaceMode;
  worktreeId?: string;
  branch?: string;
  baseRef?: string;
  ownerThreadId?: string;
  writeLeaseId?: string;
  fencingToken: string;
  revision: string;
}

export interface WorkspaceWriteLease {
  leaseId: string;
  workspaceId: string;
  ownerThreadId: string;
  authorityEpoch: string;
  fencingToken: string;
  acquiredAt: number;
  expiresAt: number;
  revisionAtAcquire: string;
}

export interface StudioWorkspaceSnapshot {
  snapshotId: string;
  workspaceId: string;
  workspaceRevision: string;
  gitHead?: string;
  patchArtifact?: string;
  untrackedArtifact?: string;
  createdAt: number;
}

export interface OmpContextCheckpointRef {
  checkpointId: string;
  threadId: string;
  ompSessionId: string;
  runtimeEpoch: string;
  createdAt: number;
}

/**
 * StudioWorkspaceSnapshot and OmpContextCheckpointRef intentionally have no
 * shared restore interface. A combined product flow must orchestrate two
 * authorities and report partial failure; it cannot claim atomic restoration.
 */

