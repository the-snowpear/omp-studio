import type { JobWidgetView, StudioAgentSnapshot, StudioJobSnapshot } from "@omp-studio/studio-protocol";
import type { PreviewMetrics } from "../../hubPreview";
import { type HubTab } from "../../pageIntents";

/** How the Agents workspace lists the roster: cards, cards by parent, or the command deck. */
export type HubView = "flat" | "tree" | "deck";

export type HubStatus = "running" | "idle" | "parked" | "aborted" | "released";

export type HubTreeNode = {
  agent: HubAgent;
  children: HubTreeNode[];
};

export type HubTreeGroup = {
  head: HubAgent;
  nodes: HubTreeNode[];
  kids: HubAgent[];
};

export type Notice = { kind: "ok" | "warn" | "err"; text: string };

export type Modal = { kind: "spawn" } | { kind: "kill"; agentId: string };

export type HubAgent = {
  peer?: boolean;
  waitingOn?: string[];
  waiters?: Array<{waiter:string; since:number; via:string[]}>;
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  status: HubStatus;
  rawStatus: StudioAgentSnapshot["status"] | HubStatus;
  activity?: string;
  task: string;
  currentTool?: { name: string; args?: string } | null;
  lastIntent?: string | null;
  retryState?: {
    attempt: number;
    maxAttempts: number;
    errorMessage?: string;
  } | null;
  modelRole?: string;
  resolvedModel?: string;
  fallback?: string | null;
  metrics?: PreviewMetrics;
  readOnly: boolean;
  unread: number;
  outputPath?: string | null;
  patchPath?: string | null;
  branchName?: string | null;
  nestedPatchPaths?: readonly string[];
  isolated?: boolean;
  canRevive?: boolean;
  children: string[];
  activeJobIds: string[];
  stage?: string;
  completionPercent?: number;
  startedAt?: number;
  lastActivity: number;
  hasLiveSession: boolean;
  hasTranscript: boolean;
  generation: number;
};

export type HubJob = {
  caption?: string | undefined;
  id: string;
  type: string;
  status: StudioJobSnapshot["status"];
  label: string;
  durationMs: number;
  ownerId: string;
  /** Subagent this job runs (task jobs); its own jobs nest under this row. */
  agentId?: string;
  generation: number;
  resultText?: string;
  errorText?: string;
  stage?: string;
  completionPercent?: number;
  widget?: JobWidgetView;
};

export type Caps = {
  open: boolean;
  openWhy: string | null;
  chat: boolean;
  chatWhy: string | null;
  revive: boolean;
  reviveWhy: string | null;
  kill: boolean;
  killWhy: string | null;
  release: boolean;
  releaseWhy: string | null;
};

export type Persisted = {
  selectedBySession: Record<string, string>;
  tab: HubTab;
};

export type HubIntent = { agentId: string; tab?: HubTab; chat?: boolean };
