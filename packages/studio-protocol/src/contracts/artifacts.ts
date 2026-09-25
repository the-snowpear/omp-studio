/** Public artifact facts. Storage roots and absolute payload paths stay private. */
export const ARTIFACT_KINDS = ["image", "video", "audio", "transcript", "judgment", "benchmark", "recording", "annotation", "export"] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly sha256: string;
}

export interface ArtifactListInput {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly kind?: ArtifactKind;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ArtifactPage {
  readonly artifacts: readonly ArtifactRecord[];
  readonly nextCursor?: string;
  readonly total: number;
  readonly totalBytes: number;
}

export interface ArtifactStorageState {
  readonly locationName: string;
  readonly writable: boolean;
  readonly total: number;
  readonly totalBytes: number;
}

export interface ArtifactTextInput {
  readonly kind: "annotation" | "judgment" | "benchmark" | "transcript" | "export";
  readonly name: string;
  readonly text: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
}
export interface ArtifactTextResult { readonly artifact: ArtifactRecord; readonly text: string }
export const ARTIFACT_TEXT_MAX_BYTES = 800000;
export function validateArtifactTextInput(value: unknown): asserts value is ArtifactTextInput {
  const input = object(value, ["kind", "name", "text", "workspaceId", "sessionId", "runId"]);
  if (!["annotation", "judgment", "benchmark", "transcript", "export"].includes(input.kind as string)) throw new Error("Invalid text artifact kind");
  short(input.name);
  if (/[\\/]/u.test(input.name as string) || !/\.(?:json|jsonl|txt|md|csv)$/iu.test(input.name as string)) throw new Error("Choose a text artifact filename");
  for (const key of ["workspaceId", "sessionId", "runId"]) short(input[key], true);
  if (typeof input.text !== "string" || new TextEncoder().encode(input.text).byteLength > ARTIFACT_TEXT_MAX_BYTES || input.text.includes("\0")) throw new Error("Text artifact exceeds its limit or contains binary data");
}
export function validateArtifactTextResult(value: unknown): asserts value is ArtifactTextResult {
  const result = object(value, ["artifact", "text"]);
  validateArtifactRecord(result.artifact);
  if (typeof result.text !== "string" || new TextEncoder().encode(result.text).byteLength > ARTIFACT_TEXT_MAX_BYTES) throw new Error("Invalid artifact text");
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected artifact object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new Error("Unknown artifact field");
  return record;
}
function short(value: unknown, optional = false): void {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f]/u.test(value)) throw new Error("Invalid artifact text");
}
function size(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid artifact size");
}
export function validateArtifactIdInput(value: unknown): asserts value is { artifactId: string } {
  const input = object(value, ["artifactId"]);
  if (typeof input.artifactId !== "string" || !/^[a-f0-9-]{36}$/u.test(input.artifactId)) throw new Error("Invalid artifact ID");
}
export function validateArtifactListInput(value: unknown): asserts value is ArtifactListInput {
  const input = object(value, ["workspaceId", "sessionId", "kind", "cursor", "limit"]);
  for (const key of ["workspaceId", "sessionId", "cursor"]) short(input[key], true);
  if (input.kind !== undefined && !(ARTIFACT_KINDS as readonly unknown[]).includes(input.kind)) throw new Error("Invalid artifact kind");
  if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) throw new Error("Invalid artifact page size");
}
export function validateArtifactRecord(value: unknown): asserts value is ArtifactRecord {
  const row = object(value, ["artifactId", "kind", "name", "mimeType", "bytes", "createdAt", "workspaceId", "sessionId", "runId", "sha256"]);
  validateArtifactIdInput({ artifactId: row.artifactId });
  if (!(ARTIFACT_KINDS as readonly unknown[]).includes(row.kind)) throw new Error("Invalid artifact kind");
  for (const key of ["name", "mimeType", "createdAt", "sha256"]) short(row[key]);
  for (const key of ["workspaceId", "sessionId", "runId"]) short(row[key], true);
  size(row.bytes);
  if (!/^[a-f0-9]{64}$/u.test(row.sha256 as string)) throw new Error("Invalid artifact digest");
}
export function validateArtifactPage(value: unknown): asserts value is ArtifactPage {
  const page = object(value, ["artifacts", "nextCursor", "total", "totalBytes"]);
  if (!Array.isArray(page.artifacts) || page.artifacts.length > 200) throw new Error("Invalid artifact page");
  page.artifacts.forEach(validateArtifactRecord);
  short(page.nextCursor, true); size(page.total); size(page.totalBytes);
}
export function validateArtifactStorageState(value: unknown): asserts value is ArtifactStorageState {
  const state = object(value, ["locationName", "writable", "total", "totalBytes"]);
  short(state.locationName); size(state.total); size(state.totalBytes);
  if (typeof state.writable !== "boolean") throw new Error("Invalid artifact storage state");
}
