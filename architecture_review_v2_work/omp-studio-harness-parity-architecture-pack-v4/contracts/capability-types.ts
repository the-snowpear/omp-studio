import type {
  AuthorityEpoch,
  EnvironmentId,
  ProjectId,
  RuntimeEpoch,
  SessionBindingId,
  ThreadId,
  WorkspaceId,
} from "./runtime-types";

export type CapabilitySurface = "execute" | "observe" | "control" | "configure" | "diagnose";

export type CapabilityScope =
  | { kind: "host" }
  | { kind: "environment"; environmentId: EnvironmentId }
  | { kind: "project"; environmentId: EnvironmentId; projectId: ProjectId }
  | { kind: "workspace"; environmentId: EnvironmentId; projectId: ProjectId; workspaceId: WorkspaceId }
  | { kind: "thread"; environmentId: EnvironmentId; projectId: ProjectId; threadId: ThreadId }
  | {
      kind: "runtime";
      environmentId: EnvironmentId;
      projectId: ProjectId;
      workspaceId: WorkspaceId;
      threadId: ThreadId;
      bindingId: SessionBindingId;
      runtimeEpoch: RuntimeEpoch;
    }
  | { kind: "preview"; environmentId: EnvironmentId; projectId: ProjectId; previewId: string };

export type CapabilityRiskTier =
  | "observe"
  | "control"
  | "workspace-write"
  | "browser-input"
  | "network"
  | "os-control"
  | "admin";

export type CapabilityRouteKind =
  | "sdk-public"
  | "rpc-ui"
  | "slash-manifest"
  | "cli"
  | "config-cli"
  | "native-file"
  | "studio-host"
  | "companion-introspection"
  | "companion-private-control"
  | "collab-experimental";

export type SupportGrade =
  | "native"
  | "supported-fallback"
  | "experimental-exact-build"
  | "experimental"
  | "unavailable";

export interface CapabilityDescriptor {
  capabilityId: string;
  surfaces: CapabilitySurface[];
  authority: "live-runtime" | "persistent-config" | "derived" | "studio";
  effectTiming: "immediate" | "next-turn" | "next-session" | "restart-required";
  determinism: "deterministic" | "model-mediated";
  scopeKinds: CapabilityScope["kind"][];
  riskTier: CapabilityRiskTier;
  reversibility: "reversible" | "compensatable" | "irreversible" | "not-applicable";
  idempotency: "idempotent" | "keyed" | "non-idempotent";
  concurrency: "parallel" | "serialize-scope" | "requires-idle";
  completionPolicy: "direct-response" | "runtime-terminal" | "event-predicate" | "not-applicable";
}

export interface CapabilityEvidence {
  kind: "source" | "runtime-probe" | "compatibility-test" | "manifest";
  buildId: string;
  reference: string;
  observedAt?: number;
  digest?: string;
}

export interface CapabilityRoute {
  routeId: string;
  capabilityId: string;
  surface: CapabilitySurface;
  routeKind: CapabilityRouteKind;
  grade: SupportGrade;
  runtimeAffinity: "same-runtime" | "external-admin" | "separate-runtime";
  stability: "public" | "semi-public" | "private";
  scopeKind: CapabilityScope["kind"];
  riskTier: CapabilityRiskTier;
  requiresControlLease?: boolean;
  requiresWriterLease?: boolean;
  requiresApproval?: boolean;
  epochBound: boolean;
  completionPolicy?: "direct-response" | "prompt-result" | "command-output" | "config-update" | "event-predicate";
  buildGuard?: { ompCommit?: string; ompBuildId?: string; companionProtocol?: string };
  evidence: CapabilityEvidence[];
}

export interface ResolvedCapability {
  id: string;
  supported: boolean;
  authorized: boolean;
  ready: boolean;
  routes: Partial<Record<CapabilitySurface, CapabilityRoute>>;
  disabledReason?:
    | "unsupported-api"
    | "build-mismatch"
    | "unauthorized"
    | "approval-required"
    | "control-lease-required"
    | "writer-lease-required"
    | "runtime-busy"
    | "stale-epoch"
    | "temporary-route-disabled";
  notes?: string[];
}

export type CapabilityState = ResolvedCapability;

export type SlashSemanticKind = "local-deterministic" | "model-dispatched" | "tui-only" | "unknown";

export interface SlashManifestEntry {
  name: string;
  aliases: string[];
  source: string;
  description?: string;
  input?: { hint?: string; schema?: Record<string, unknown> };
  semanticKind: SlashSemanticKind;
  surface?: CapabilitySurface;
  scopeKind?: CapabilityScope["kind"];
  riskTier?: CapabilityRiskTier;
  completionPolicy?: CapabilityRoute["completionPolicy"];
  mayElicit: boolean;
  buildGuard?: CapabilityRoute["buildGuard"];
  evidence: CapabilityEvidence[];
}

export interface SlashManifest {
  protocol: string;
  ompBuildId: string;
  companionVersion?: string;
  manifestHash: string;
  commands: SlashManifestEntry[];
  generatedAt: number;
}

export interface CapabilityDebtItem {
  debtId: string;
  capabilityId: string;
  surface: CapabilitySurface;
  scopeKind: CapabilityScope["kind"];
  summary: string;
  harnessEvidence: CapabilityEvidence[];
  missingPublicSurface: string;
  temporaryRoute?: Pick<CapabilityRoute, "routeKind" | "grade" | "buildGuard">;
  upstreamProposal?: string;
  owner?: string;
  introducedBuild: string;
  targetMilestone?: string;
  reviewBy: number;
  killSwitch: string;
  requiredTests: string[];
  removalCondition: string;
  status: "open" | "temporary-route" | "upstream-pending" | "closed";
}

export interface CapabilitySnapshot {
  snapshotId: string;
  snapshotHash: string;
  authorityEpoch: AuthorityEpoch;
  scope: CapabilityScope;
  bindingId?: SessionBindingId;
  runtimeEpoch?: RuntimeEpoch;
  ompVersion: string;
  ompCommit?: string;
  ompBuildId?: string;
  backend?: "sdk" | "rpc-ui";
  rpcProtocol?: number;
  authzRevision: number;
  slashManifestHash?: string;
  capabilities: Record<string, ResolvedCapability>;
  debt: CapabilityDebtItem[];
  generatedAt: number;
}
