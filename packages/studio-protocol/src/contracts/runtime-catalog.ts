export interface PromptTemplateRow { id: string; name: string; description: string; source: string; version: string }
export interface McpRuntimeStatus {
  available: boolean; startupTimeoutMs: number; ready: boolean; settled: boolean;
  servers: Array<{ name: string; state: "ready" | "pending" | "failed" | "disconnected"; tools: number }>;
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
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid catalog number"); }
function version(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid template version"); }
function row(value: unknown): void {
  const entry = record(value, ["id", "name", "description", "source", "version"]);
  for (const field of ["id", "name", "source"]) text(entry[field]); text(entry.description, 2000, true); version(entry.version);
}
export function validateRuntimeCatalogOperation(value: unknown): asserts value is RuntimeCatalogOperation {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string" || !isRuntimeCatalogOperationKind(kind)) throw new Error("Unknown Runtime catalog operation");
  const fields = kind === "templates.list" ? ["cursor", "limit"] : kind === "templates.get" ? ["id", "version"] : kind === "templates.prepare" ? ["id", "version", "arguments"] : [];
  const input = record(value, ["kind", "sessionId", ...fields]); text(input.sessionId);
  if (kind === "templates.get" || kind === "templates.prepare") { text(input.id); version(input.version); }
  if (kind === "templates.prepare") text(input.arguments, 32000, true);
  if (input.cursor !== undefined) text(input.cursor); if (input.limit !== undefined) integer(input.limit, 1, 50);
}
export function validateRuntimeCatalogResult(kind: RuntimeCatalogOperation["kind"], value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 800000) throw new Error("Runtime catalog result exceeds the wire budget");
  if (kind === "templates.list") {
    const input = record(value, ["templates", "nextCursor"]);
    if (!Array.isArray(input.templates) || input.templates.length > 50) throw new Error("Invalid template page"); input.templates.forEach(row);
    if (input.nextCursor !== undefined) text(input.nextCursor);
  } else if (kind === "templates.get") {
    const input = record(value, ["template", "content"]); row(input.template); text(input.content, 400000, true);
  } else if (kind === "templates.prepare") { const input = record(value, ["text"]); text(input.text, 600000, true); }
  else {
    const input = record(value, ["available", "startupTimeoutMs", "ready", "settled", "servers", "total"]);
    for (const field of ["available", "ready", "settled"]) if (typeof input[field] !== "boolean") throw new Error("Invalid MCP status flag");
    integer(input.total); if (typeof input.startupTimeoutMs !== "number" || !Number.isFinite(input.startupTimeoutMs) || input.startupTimeoutMs < 0) throw new Error("Invalid startup timeout");
    if (!Array.isArray(input.servers) || input.servers.length > 500) throw new Error("Invalid MCP status list");
    for (const entry of input.servers) {
      const server = record(entry, ["name", "state", "tools"]); text(server.name); integer(server.tools);
      if (!["ready", "pending", "failed", "disconnected"].includes(server.state as string)) throw new Error("Invalid MCP state");
    }
  }
}
