export interface PromptTemplateRow { id: string; name: string; description: string; source: string; version: string }
export interface McpRuntimeStatus {
  available: boolean; startupTimeoutMs: number; ready: boolean; settled: boolean;
  servers: Array<{
    name: string;
    state: "ready" | "pending" | "failed" | "disconnected";
    tools: number;
    transport?: "stdio" | "http" | "sse";
    source?: { providerName: string; level: "user" | "project" | "native" };
    error?: string;
    toolInfo?: Array<{ name: string; mcpServerName: string; mcpToolName: string; description?: string; readOnlyHint?: boolean }>;
  }>;
  total: number;
}
export type RuntimeCatalogOperation =
  | { kind: "templates.list"; sessionId: string; cursor?: string; limit?: number }
  | { kind: "templates.get"; sessionId: string; id: string; version: string }
  | { kind: "templates.prepare"; sessionId: string; id: string; version: string; arguments: string }
  | { kind: "mcp.runtime.status"; sessionId: string };
export interface RuntimeCatalogResultMap {
  "templates.list": { templates: PromptTemplateRow[]; nextCursor?: string };
  "templates.get": { template: PromptTemplateRow; content: string };
  "templates.prepare": { text: string };
  "mcp.runtime.status": McpRuntimeStatus;
}
export const RUNTIME_CATALOG_OPERATION_KINDS = ["templates.list", "templates.get", "templates.prepare", "mcp.runtime.status"] as const;
export function isRuntimeCatalogOperationKind(kind: string): kind is RuntimeCatalogOperation["kind"] { return (RUNTIME_CATALOG_OPERATION_KINDS as readonly string[]).includes(kind); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Runtime catalog object");
  const row = value as Record<string, unknown>; if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown catalog field"); return row;
}
function text(value: unknown, max = 512, empty = false): void { if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || value.length > max) throw new Error("Invalid catalog text"); }
function version(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid template version"); }
function row(value: unknown): void {
  const entry = record(value, ["id", "name", "description", "source", "version"]);
  for (const field of ["id", "name", "source"]) text(entry[field]); text(entry.description, 2000, true); version(entry.version);
}
