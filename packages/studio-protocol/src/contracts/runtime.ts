import type {
  EnvironmentId,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
  ThreadId,
  WorkspaceId,
} from "./ids";

export type RuntimePreference =
  | { kind: "managed" }
  | { kind: "system"; executable?: string; allowLimited: boolean }
  | { kind: "custom"; executable: string; allowLimited: boolean };

export type RuntimeClassification =
  | "managed"
  | "compatible-system"
  | "limited-system"
  | "rejected";

export type RuntimeBackend = "studio-host" | "rpc-ui" | "acp";

export interface SessionBinding {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  workspaceId: WorkspaceId;
  runtimeId: RuntimeId;
  runtimeEpoch: RuntimeEpoch;
  classification: Exclude<RuntimeClassification, "rejected">;
  backend: RuntimeBackend;
  runtimeVersion: string;
  upstreamVersion: string;
  upstreamCommit: string;
  ompSessionId?: SessionId;
  capabilityHash: string;
  commandManifestHash?: string;
}

export interface RuntimeProbeResult {
  classification: RuntimeClassification;
  executableIdentity: string;
  runtimeVersion?: string;
  upstreamVersion?: string;
  upstreamCommit?: string;
  selectedProtocolVersion?: number;
  capabilityHash?: string;
  commandManifestHash?: string;
  missingCapabilities: string[];
  warnings: string[];
  rejectionReason?: string;
}

export interface RuntimeIdentitySnapshot {
  runtimeId: RuntimeId;
  runtimeEpoch: RuntimeEpoch;
  runtimeVersion: string;
  upstreamVersion: string;
  upstreamCommit: string;
  stateVersion: StateVersion;
  sessionId: SessionId;
}

export interface RuntimeInstallationManifest {
  runtimeVersion: string;
  upstreamVersion: string;
  upstreamCommit: string;
  patchsetVersion: string;
  studioProtocol: { min: number; max: number };
  /** Limited is required while a managed build truthfully exposes only a verified subset. */
  profile: "full-parity-v1" | "limited";
  capabilityHash: string;
  commandManifestHash: string;
  platform: string;
  entrypoint: string;
  channel: "stable" | "canary";
}
