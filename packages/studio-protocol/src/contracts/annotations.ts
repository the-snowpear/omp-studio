/** A frozen source and its exact-text anchors. No executable paths or UI markup. */
export interface AnnotationSource {
  id: string; kind: "message" | "quote" | "file" | "diff"; label: string; text: string;
  version: string; path?: string; sessionId?: string; messageId?: string;
}
export interface AnnotationNote {
  id: string; sourceId: string; note: string;
  /** UTF-16 offsets in the captured source, end exclusive. Omitted means whole source. */
  selection?: { start: number; end: number };
}
export type AnnotationCapture =
  | { kind: "file"; path: string }
  | { kind: "diff"; path?: string }
  | { kind: "message" | "quote"; text: string; label: string; sessionId?: string; messageId?: string };
export interface AnnotationBundle {
  schemaVersion: 1; revision: number; sources: AnnotationSource[]; notes: AnnotationNote[];
  workspaceId?: string; sessionId?: string;
}
export type AnnotationOperation =
  | { kind: "annotations.capture"; source: AnnotationCapture }
  | { kind: "annotations.prepare"; sources: AnnotationSource[]; notes: AnnotationNote[]; action: "feedback" | "review"; allowStale?: boolean };
export interface AnnotationResultMap {
  "annotations.capture": { source: AnnotationSource };
  "annotations.prepare": { prompt: string; staleSources: string[] };
}
export const ANNOTATION_OPERATION_KINDS = ["annotations.capture", "annotations.prepare"] as const;
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid annotation object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown annotation field");
  return row;
}
function text(value: unknown, max = 512, empty = false): void { if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || value.length > max) throw new Error("Invalid annotation text"); }
function integer(value: unknown, min = 0): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Error("Invalid annotation offset"); }
function relative(value: unknown): void { text(value, 4096); if (/^(?:[A-Za-z]:|[\\/])/u.test(value as string) || (value as string).split(/[\\/]/u).includes("..")) throw new Error("Annotation paths must be workspace-relative"); }
function source(value: unknown): asserts value is AnnotationSource {
  const row = object(value, ["id", "kind", "label", "text", "version", "path", "sessionId", "messageId"]);
  text(row.id); text(row.label); text(row.text, 120000, true);
  if (!["message", "quote", "file", "diff"].includes(row.kind as string)) throw new Error("Invalid annotation source kind");
  if (typeof row.version !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(row.version)) throw new Error("Invalid annotation source version");
  if (row.path !== undefined) relative(row.path);
  if (row.kind === "file" && row.path === undefined) throw new Error("Missing annotation file");
  if (row.sessionId !== undefined) text(row.sessionId);
  if (row.messageId !== undefined) text(row.messageId);
}
function content(sources: unknown, notes: unknown): void {
  if (!Array.isArray(sources) || sources.length > 16 || !Array.isArray(notes) || notes.length > 128) throw new Error("Annotation bundle exceeds its limit");
  const sourceMap = new Map<string, AnnotationSource>();
  for (const item of sources) { source(item); if (sourceMap.has(item.id)) throw new Error("Duplicate annotation source"); sourceMap.set(item.id, item); }
  const noteIds = new Set<string>();
  for (const item of notes) {
    const row = object(item, ["id", "sourceId", "note", "selection"]);
    text(row.id); text(row.sourceId); text(row.note, 8000);
    if (noteIds.has(row.id as string)) throw new Error("Duplicate annotation"); noteIds.add(row.id as string);
    const linked = sourceMap.get(row.sourceId as string); if (!linked) throw new Error("Annotation source is missing");
    if (row.selection !== undefined) {
      const range = object(row.selection, ["start", "end"]); integer(range.start); integer(range.end, 1);
      if ((range.start as number) >= (range.end as number) || (range.end as number) > linked.text.length) throw new Error("Annotation selection is outside the source");
    }
  }
  if (byteLength(JSON.stringify({ sources, notes })) > 750000) throw new Error("Annotation bundle is too large; split it into smaller groups");
}
export function validateAnnotationBundle(value: unknown): asserts value is AnnotationBundle {
  const row = object(value, ["schemaVersion", "revision", "sources", "notes", "workspaceId", "sessionId"]);
  if (row.schemaVersion !== 1) throw new Error("Unsupported annotation format"); integer(row.revision, 1);
  if (row.workspaceId !== undefined) text(row.workspaceId); if (row.sessionId !== undefined) text(row.sessionId);
  content(row.sources, row.notes);
}
export function validateAnnotationOperation(value: unknown): asserts value is AnnotationOperation {
  if (!value || typeof value !== "object") throw new Error("Invalid annotation operation");
  if ((value as { kind?: string }).kind === "annotations.capture") {
    const row = object(value, ["kind", "source"]);
    const input = row.source as Record<string, unknown>;
    if (input?.kind === "file" || input?.kind === "diff") {
      object(input, ["kind", "path"]);
      if (input.kind === "file" || input.path !== undefined) relative(input.path);
    } else {
      object(input, ["kind", "text", "label", "sessionId", "messageId"]);
      if (input.kind !== "message" && input.kind !== "quote") throw new Error("Invalid annotation capture kind");
      text(input.text, 120000, true); text(input.label);
      if (input.sessionId !== undefined) text(input.sessionId); if (input.messageId !== undefined) text(input.messageId);
    }
  } else {
    const row = object(value, ["kind", "sources", "notes", "action", "allowStale"]);
    if (row.kind !== "annotations.prepare" || !["feedback", "review"].includes(row.action as string)) throw new Error("Invalid annotation action");
    if (row.allowStale !== undefined && typeof row.allowStale !== "boolean") throw new Error("Invalid stale-source choice");
    content(row.sources, row.notes);
  }
}
export function validateAnnotationResult(kind: AnnotationOperation["kind"], value: unknown): void {
  if (byteLength(JSON.stringify(value)) > 800000) throw new Error("Annotation result exceeds the encoded control-frame budget");
  if (kind === "annotations.capture") { const result = object(value, ["source"]); source(result.source); }
  else {
    const result = object(value, ["prompt", "staleSources"]); text(result.prompt, 800000, true);
    if (byteLength(result.prompt as string) > 800000) throw new Error("Annotation prompt exceeds the control-frame budget");
    if (!Array.isArray(result.staleSources) || result.staleSources.length > 16) throw new Error("Invalid stale-source list");
    result.staleSources.forEach(item => text(item));
  }
}
