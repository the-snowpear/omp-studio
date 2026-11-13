/**
 * OMP 18.11–18.12 Runtime features surfaced to Studio: remembered approvals,
 * job inspection and widgets, MCP re-authorization and read-only Seance.
 * Validation stays at shape level; the overlay services enforce semantics.
 */

/** Upstream `TspTone` (pi-wire): colour intent of a widget part. */
export type JobWidgetTone = "neutral" | "accent" | "info" | "success" | "warning" | "error" | "pending" | "muted" | "user";
export interface JobWidgetTrend { text: string; tone: "success" | "error" | "muted" }
export type JobWidgetBlock =
  | { kind: "spark"; label: string; values: number[]; min: number; max: number; marks?: Array<{ value: number; label: string; tone?: JobWidgetTone }>; last: string; tips?: string[]; tone?: JobWidgetTone }
  | { kind: "bars"; label: string; items: Array<{ label: string; value: number; text: string; tone?: JobWidgetTone }>; max: number }
  | { kind: "meter"; label: string; value: number; text: string; tone?: JobWidgetTone }
  | { kind: "stat"; items: Array<{ label: string; text: string; tone?: JobWidgetTone; trend?: JobWidgetTrend }> }
  | { kind: "grid"; label: string; items: Array<{ label: string; text: string; tone: JobWidgetTone }> }
  | { kind: "text"; text: string };
/** Upstream `JobWidgetView`: plain JSON, re-rendered in React (never the TUI renderer). */
export interface JobWidgetView {
  title: string;
  headline?: { text: string; label?: string; trend?: JobWidgetTrend };
  stage?: string;
  blocks: JobWidgetBlock[];
  state: "authoring" | "live" | "fallback";
  updatedAt: number;
}

/** Upstream `AsyncJobInspection` for one job. */
export interface JobInspection {
  purpose?: string;
  caption?: string;
  jobId: string;
  command?: string;
  cwd?: string;
  pids: number[];
  exitCode?: number;
  /** Output tail, bounded by the Runtime. */
  output?: string;
  artifactId?: string;
  widget?: JobWidgetView;
}

export interface McpAuthResult {
  name: string;
  status: "authorized" | "cancelled" | "refused" | "removed" | "connected" | "failed";
  /** Authorization URL the Runtime opened in the browser, when the flow produced one. */
  authUrl?: string;
  /** Which configuration file the server was found in. */
  scope?: "project" | "user";
  message?: string;
}

export interface SeanceResult {
  /** The answer text of the read-only consult. */
  text: string;
  sourceSessionId: string;
  /** Agent id to send follow-up questions to, when the consult stays addressable. */
  agentId?: string;
  model?: string;
  /** `running` when `async.enabled` detached the consult into a background job (`text` is then a notice). */
  state: "completed" | "running";
  jobId?: string;
}

export type RuntimeFeatureOperation =
  | { kind: "agent.spawn.options"; sessionId: string; definition: string }
  | { kind: "btw.inject"; sessionId: string; injectId: string }
  | { kind: "session.history.rename"; sessionId: string; targetSessionId: string; title: string }
  | { kind: "session.history.pin"; sessionId: string; targetSessionId: string; pinned: boolean }
  | { kind: "session.lease.inspect"; sessionId: string; targetSessionIds: string[] }
  | { kind: "approvals.forget"; sessionId: string }
  | { kind: "jobs.inspect"; sessionId: string; jobId: string }
  | { kind: "mcp.auth.reauth"; sessionId: string; name: string }
  | { kind: "mcp.auth.unauth"; sessionId: string; name: string }
  | { kind: "mcp.auth.reconnect"; sessionId: string; name: string }
  | { kind: "seance.ask"; sessionId: string; source: string; task: string; model?: string };
export interface RuntimeFeatureResultMap {
  "agent.spawn.options": { fileEnabled: boolean; modelSelection: boolean; maxEffort: string; models: Array<{ selector: string; name: string; thinkingLevels: readonly string[] }> };
  "btw.inject": { sent: true };
  "session.history.rename": { targetSessionId: string; title: string };
  "session.history.pin": { targetSessionId: string; pinned: boolean };
  "session.lease.inspect": { held: string[]; unknown: string[] };
  "approvals.forget": { cleared: true };
  "jobs.inspect": JobInspection;
  "mcp.auth.reauth": McpAuthResult;
  "mcp.auth.unauth": McpAuthResult;
  "mcp.auth.reconnect": McpAuthResult;
  "seance.ask": SeanceResult;
}
export const RUNTIME_FEATURE_KINDS = ["agent.spawn.options", "btw.inject", "session.history.rename", "session.history.pin", "session.lease.inspect", "approvals.forget", "jobs.inspect", "mcp.auth.reauth", "mcp.auth.unauth", "mcp.auth.reconnect", "seance.ask"] as const;
export const RUNTIME_FEATURE_READ_KINDS = ["agent.spawn.options", "btw.inject", "session.history.rename", "session.history.pin", "session.lease.inspect", "jobs.inspect"] as const;
export function isRuntimeFeatureKind(kind: string): kind is RuntimeFeatureOperation["kind"] { return (RUNTIME_FEATURE_KINDS as readonly string[]).includes(kind); }
