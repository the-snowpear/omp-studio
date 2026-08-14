export type CapabilitySurface =
  | "execute"
  | "observe"
  | "control"
  | "configure"
  | "diagnose";

export type CapabilityScopeKind =
  | "host"
  | "project"
  | "workspace"
  | "thread"
  | "runtime"
  | "preview";

export type ResourceScope =
  | { kind: "host" }
  | { kind: "project"; projectId: string }
  | { kind: "workspace"; projectId: string; workspaceId: string }
  | { kind: "thread"; projectId: string; threadId: string }
  | { kind: "runtime"; projectId: string; threadId: string; runtimeEpoch: string }
  | { kind: "preview"; projectId: string; previewId: string };

export type CapabilityRiskTier =
  | "observe"
  | "control"
  | "workspace-write"
  | "browser-input"
  | "network"
  | "os-control"
  | "admin";

export type OmpChannel =
  | "rpc-ui"
  | "slash-rpc"
  | "cli"
  | "config-cli"
  | "native-file"
  | "studio-host"
  | "companion-extension"
  | "collab-experimental";

export type SupportGrade =
  | "native"
  | "supported-fallback"
  | "experimental"
  | "unavailable";

export interface CapabilityRoute {
  capabilityId: string;
  surface: CapabilitySurface;
  channel: OmpChannel;
  grade: SupportGrade;
  reason: string;
  requiredScope: CapabilityScopeKind;
  riskTier: CapabilityRiskTier;
  requiresControlLease?: boolean;
  requiresWriterLease?: boolean;
  epochBound?: boolean;
  requiresRestart?: boolean;
  versionGuard?: string;
}

export interface CapabilityState {
  id: string;
  supported: boolean;
  authorized: boolean;
  ready: boolean;
  surfaces: Partial<Record<CapabilitySurface, CapabilityRoute>>;
  disabledReason?: string;
  notes?: string[];
}

export interface CapabilitySnapshot {
  snapshotId: string;
  hostEpoch: string;
  ompVersion: string;
  ompBuildId?: string;
  scope: ResourceScope;
  runtimeEpoch?: string;
  rpcProtocol?: number;
  rpcMethods: string[];
  rpcEvents: string[];
  slashCommands: Array<{ name: string; source: string }>;
  authzRevision: number;
  capabilities: Record<string, CapabilityState>;
  generatedAt: number;
}
