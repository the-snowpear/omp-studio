/** Computer workspace metadata. Image bytes and native filesystem paths never cross this contract. */
export interface ComputerTarget {
  id: string;
  kind: "display" | "window";
  name: string;
  width: number;
  height: number;
}

export interface ComputerFrame {
  frameId: string;
  sessionId: string;
  source: "execution" | "observation";
  capturedAt: number;
  targetId: string;
  targetName?: string;
  runId?: string;
  actionId?: string;
  toolCallId?: string;
  agentId?: string;
  width: number;
  height: number;
  coordinateWidth: number;
  coordinateHeight: number;
  sourceWidth?: number;
  sourceHeight?: number;
  region?: { x: number; y: number; width: number; height: number };
  screenLocked: boolean;
  delivered: boolean;
  availability: "available" | "pending" | "expired" | "unavailable";
  artifactId?: string;
  expiresAt?: number;
}

export interface ComputerAction {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId?: string;
  agentId?: string;
  agentName?: string;
  method: string;
  targetId?: string;
  targetName?: string;
  mode: "read" | "background" | "takeover" | "unknown";
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  frameIds: string[];
  error?: string;
}

export interface ComputerControlState {
  status: "allowed" | "stopping" | "stopped" | "continuing" | "unconfirmed";
  revision: number;
  updatedAt: number;
  reason?: string;
  foreground: "none" | "requested" | "held" | "unknown";
}

export interface ComputerWorkspaceSnapshot {
  version: 1;
  sessionId: string;
  revision: number;
  updatedAt: number;
  enabled: boolean;
  preludeAvailable: boolean;
  backend: string;
  capabilities: { capture: boolean; input: boolean; accessibility: boolean; globalEscape: boolean; observationOnly: boolean };
  permissions: { capture: string; input: string; accessibility: string };
  /** Only true when the native backend can distinguish unlocked/awake from unknown. */
  screen: { locked: boolean; asleep: boolean; known?: boolean };
  control: ComputerControlState;
  targets: ComputerTarget[];
  active: ComputerAction[];
  frames: ComputerFrame[];
  reason?: string;
}

export interface ComputerActivityPage {
  items: ComputerAction[];
  frames: ComputerFrame[];
  revision: number;
  nextCursor?: string;
}

export interface ComputerObservationLease {
  leaseId: string;
  sessionId: string;
  expiresAt: number;
}

export interface ComputerStructureNode {
  id: string;
  role: string;
  name: string;
  enabled: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  children: ComputerStructureNode[];
}

export interface ComputerStructureSnapshot {
  snapshotId: string;
  sessionId: string;
  targetId: string;
  capturedAt: number;
  frame?: ComputerFrame;
  nodes: ComputerStructureNode[];
  truncated: boolean;
  /** Bounds are expressed in the accompanying frame's pixel coordinate space. */
  coordinateSpace: "frame" | "unavailable";
  reason?: string;
}

export type ComputerWorkspaceQuery =
  | { kind: "computer.workspace.get"; sessionId: string }
  | { kind: "computer.activity.list"; sessionId: string; cursor?: string; limit?: number }
  | { kind: "computer.frame.get"; sessionId: string; frameId: string }
  | { kind: "computer.structure.get"; sessionId: string; leaseId: string; targetId: string };

export type ComputerWorkspaceCommand =
  | { kind: "computer.observe.open"; sessionId: string; consumerId: string }
  | { kind: "computer.observe.close"; sessionId: string; leaseId: string }
  | { kind: "computer.frame.capture"; sessionId: string; leaseId: string; targetId: string }
  | { kind: "computer.control.stop"; sessionId: string; reason?: "stop" | "handoff" | "disable" }
  | { kind: "computer.control.continue"; sessionId: string; revision: number };

export type ComputerWorkspaceOperation = ComputerWorkspaceQuery | ComputerWorkspaceCommand;

export interface ComputerWorkspaceResultMap {
  "computer.workspace.get": ComputerWorkspaceSnapshot;
  "computer.activity.list": ComputerActivityPage;
  "computer.frame.get": ComputerFrame | null;
  "computer.structure.get": ComputerStructureSnapshot;
  "computer.observe.open": ComputerObservationLease;
  "computer.observe.close": { released: true };
  "computer.frame.capture": ComputerFrame;
  "computer.control.stop": ComputerControlState;
  "computer.control.continue": { queued: boolean; control: ComputerControlState };
}

export type ComputerWorkspaceChange =
  | { sessionId: string; revision: number; kind: "state"; snapshot: ComputerWorkspaceSnapshot }
  | { sessionId: string; revision: number; kind: "action"; action: ComputerAction }
  | { sessionId: string; revision: number; kind: "frame"; frame: ComputerFrame }
  | { sessionId: string; revision: number; kind: "reset" };

export const COMPUTER_WORKSPACE_QUERY_KINDS = ["computer.workspace.get", "computer.activity.list", "computer.frame.get", "computer.structure.get"] as const;
export const COMPUTER_WORKSPACE_COMMAND_KINDS = ["computer.observe.open", "computer.observe.close", "computer.frame.capture", "computer.control.stop", "computer.control.continue"] as const;
export const COMPUTER_WORKSPACE_KINDS = [...COMPUTER_WORKSPACE_QUERY_KINDS, ...COMPUTER_WORKSPACE_COMMAND_KINDS] as const;
export function isComputerWorkspaceQuery(kind: string): kind is ComputerWorkspaceQuery["kind"] {
  return (COMPUTER_WORKSPACE_QUERY_KINDS as readonly string[]).includes(kind);
}
export function isComputerWorkspaceCommand(kind: string): kind is ComputerWorkspaceCommand["kind"] {
  return (COMPUTER_WORKSPACE_COMMAND_KINDS as readonly string[]).includes(kind);
}
export function isComputerWorkspaceKind(kind: string): kind is ComputerWorkspaceOperation["kind"] {
  return (COMPUTER_WORKSPACE_KINDS as readonly string[]).includes(kind);
}
