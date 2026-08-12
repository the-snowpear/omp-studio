import type { AgentId, Generation, JobId, OpaqueCursor } from "./ids";

export type AgentStatus =
  | "starting"
  | "running"
  | "idle"
  | "parked"
  | "reviving"
  | "aborted"
  | "failed"
  | "released";

export interface StudioAgentSnapshot {
  agentId: AgentId;
  generation: Generation;
  parentAgentId?: AgentId;
  kind: string;
  displayName: string;
  status: AgentStatus;
  assignment?: string;
  summary?: string;
  startedAt?: string;
  updatedAt: string;
  hasLiveSession: boolean;
  hasTranscript: boolean;
  unreadCount: number;
  activeJobIds: JobId[];
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface StudioJobSnapshot {
  jobId: JobId;
  generation: Generation;
  ownerAgentId: AgentId;
  agentId?: AgentId;
  type: string;
  label: string;
  status: JobStatus;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
}

export type AgentOperation =
  | { kind: "agent.list"; includeTerminal?: boolean; includePersisted?: boolean }
  | { kind: "agent.get"; agentId: AgentId }
  | {
      kind: "agent.spawn";
      definition: string;
      assignment: string;
      context?: string;
      async?: boolean;
      isolation?: string;
      effort?: string;
    }
  | {
      kind: "agent.send";
      agentId: AgentId;
      expectedGeneration: Generation;
      text: string;
      mode: "prompt" | "steer" | "followUp";
    }
  | { kind: "agent.kill"; agentId: AgentId; expectedGeneration: Generation }
  | { kind: "agent.revive"; agentId: AgentId; expectedGeneration: Generation }
  | { kind: "agent.release"; agentId: AgentId; expectedGeneration: Generation }
  | { kind: "agent.transcript.read"; agentId: AgentId; cursor?: OpaqueCursor; limit?: number }
  | { kind: "agent.subscribe"; level: "progress" | "events" };

export type JobOperation =
  | { kind: "job.list"; ownerAgentId?: AgentId; includeRecent?: boolean }
  | { kind: "job.get"; jobId: JobId }
  | { kind: "job.cancel"; jobId: JobId; expectedGeneration: Generation }
  | { kind: "job.subscribe" };

export interface AgentTranscriptPage<TMessage = unknown> {
  agentId: AgentId;
  generation: Generation;
  cursor: OpaqueCursor;
  nextCursor?: OpaqueCursor;
  messages: TMessage[];
  eof: boolean;
}

