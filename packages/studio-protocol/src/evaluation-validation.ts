import { EVALUATION_LIMITS as L, type EvaluationOperation } from "./contracts/evaluation.js";

/** Mirrored by Runtime: no Node, browser, or transport dependencies. */
export class EvaluationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationValidationError";
  }
}

const SHAPES = {
  "browser.evaluate": ["kind", "expression", "target", "timeoutMs"],
  "computer.evaluate": ["kind", "action", "target", "timeoutMs"],
  "image.read": ["kind", "image", "question"],
  "terminal.image": ["kind", "result"],
  "video.metadata": ["kind", "attachmentId"],
  "video.frame": ["kind", "attachmentId", "timestampMs"],
  "eval.agent.start": ["kind", "definition", "assignment", "async"],
  "eval.agent.status": ["kind", "jobId", "expectedGeneration"],
  "eval.agent.wait": ["kind", "jobId", "expectedGeneration", "timeoutMs"],
  "eval.agent.cancel": ["kind", "jobId", "expectedGeneration"],
  "eval.completion.start": ["kind", "prompt", "model", "system", "schema"],
  "eval.completion.status": ["kind", "jobId", "expectedGeneration"],
  "eval.completion.wait": ["kind", "jobId", "expectedGeneration", "timeoutMs"],
  "eval.completion.cancel": ["kind", "jobId", "expectedGeneration"],
  "eval.workpool.status": ["kind", "name", "ownerAgentId"],
} as const;

export function isEvaluationOperationKind(kind: string): kind is EvaluationOperation["kind"] {
  return Object.hasOwn(SHAPES, kind);
}

function fail(message: string): never { throw new EvaluationValidationError(message); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${field} must be a plain object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}: unknown field ${key}`);
}
function string(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    fail(`${field} must be a non-empty string of at most ${max} characters without NUL`);
  }
  return value;
}
function positive(value: unknown, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    fail(`${field} must be an integer between 1 and ${max}`);
  }
  return value;
}

/** Validate Base64 without decoding or allocating a second large buffer. */
function imageData(value: unknown): void {
  const data = string(value, Math.ceil(L.IMAGE_MAX_BYTES / 3) * 4, "result.data");
  if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    fail("result.data must be canonical Base64");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const tail = alphabet.indexOf(data[data.length - padding - 1]!);
  if ((padding === 2 && (tail & 15) !== 0) || (padding === 1 && (tail & 3) !== 0)) fail("result.data has nonzero Base64 pad bits");
  if (data.length / 4 * 3 - padding > L.IMAGE_MAX_BYTES) fail("result.data exceeds image byte limit");
}

function schema(value: unknown): void {
  object(value, "schema");
  const seen = new Set<object>();
  let bytes = 0;
  const encoder = new TextEncoder();
  const visit = (node: unknown, depth: number): void => {
    if (depth > L.SCHEMA_MAX_DEPTH) fail("schema exceeds depth limit");
    if (node === null || typeof node === "boolean") bytes += 5;
    else if (typeof node === "number") {
      if (!Number.isFinite(node)) fail("schema numbers must be finite");
      bytes += String(node).length;
    } else if (typeof node === "string") bytes += encoder.encode(JSON.stringify(node)).length;
    else if (typeof node === "object") {
      if (seen.has(node)) fail("schema cannot contain cycles");
      seen.add(node);
      if (!Array.isArray(node)) object(node, "schema member");
      bytes += 2;
      for (const [key, entry] of Object.entries(node)) {
        bytes += encoder.encode(JSON.stringify(key)).length + 2;
        visit(entry, depth + 1);
      }
      seen.delete(node);
    } else fail("schema must be JSON data");
    if (bytes > L.SCHEMA_MAX_BYTES) fail("schema exceeds byte limit");
  };
  visit(value, 0);
}

export function parseEvaluationOperation(value: unknown): EvaluationOperation {
  const op = object(value, "operation");
  if (typeof op.kind !== "string" || !isEvaluationOperationKind(op.kind)) fail("unknown evaluation operation");
  keys(op, SHAPES[op.kind], "operation");
  if (op.timeoutMs !== undefined) positive(op.timeoutMs, L.TIMEOUT_MAX_MS, "timeoutMs");
  if (op.expectedGeneration !== undefined || op.kind.endsWith(".cancel")) {
    positive(op.expectedGeneration, Number.MAX_SAFE_INTEGER, "expectedGeneration");
  }
  switch (op.kind) {
    case "browser.evaluate":
    case "computer.evaluate": {
      const codeKey = op.kind === "browser.evaluate" ? "expression" : "action";
      string(op[codeKey], L.TEXT_MAX_CHARS, codeKey);
      if (op.target !== undefined) {
        const target = object(op.target, "target");
        keys(target, ["url", "tabId", "elementHandle"], "target");
        if (target.url !== undefined) {
          const url = string(target.url, L.PATH_MAX_CHARS, "target.url");
          let protocol: string;
          try { protocol = new URL(url).protocol; } catch { fail("target.url must be an absolute URL"); }
          if (protocol !== "http:" && protocol !== "https:") fail("target.url must use http or https");
        }
        for (const key of ["tabId", "elementHandle"]) if (target[key] !== undefined) string(target[key], L.ID_MAX_CHARS, `target.${key}`);
      }
      break;
    }
    case "image.read":
      string(op.image, L.PATH_MAX_CHARS, "image path");
      string(op.question, L.TEXT_MAX_CHARS, "question");
      break;
    case "terminal.image": {
      const result = object(op.result, "result");
      keys(result, ["encoding", "data", "mimeType", "width", "height", "source"], "result");
      if (result.encoding !== "base64") fail("result.encoding must be base64");
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(result.mimeType))) fail("result.mimeType must be a raster image MIME type");
      if (result.source !== "kitty" && result.source !== "sixel") fail("result.source must be kitty or sixel");
      imageData(result.data);
      if (result.width !== undefined) positive(result.width, L.IMAGE_MAX_EDGE, "result.width");
      if (result.height !== undefined) positive(result.height, L.IMAGE_MAX_EDGE, "result.height");
      if (typeof result.width === "number" && typeof result.height === "number" && result.width * result.height > L.IMAGE_MAX_PIXELS) fail("result exceeds pixel limit");
      break;
    }
    case "video.metadata":
    case "video.frame":
      string(op.attachmentId, L.PATH_MAX_CHARS, "attachmentId");
      if (op.kind === "video.frame" && (typeof op.timestampMs !== "number" || !Number.isFinite(op.timestampMs) || op.timestampMs < 0 || op.timestampMs > Number.MAX_SAFE_INTEGER)) fail("timestampMs must be a finite non-negative timestamp");
      break;
    case "eval.agent.start":
      string(op.definition, L.DEFINITION_MAX_CHARS, "definition");
      string(op.assignment, L.TEXT_MAX_CHARS, "assignment");
      if (op.async !== undefined && typeof op.async !== "boolean") fail("async must be a boolean");
      break;
    case "eval.completion.start":
      string(op.prompt, L.TEXT_MAX_CHARS, "prompt");
      if (op.system !== undefined) string(op.system, L.TEXT_MAX_CHARS, "system");
      if (op.model !== undefined && !["smol", "default", "slow"].includes(String(op.model))) fail("unsupported completion model role");
      if (op.schema !== undefined) schema(op.schema);
      break;
    case "eval.workpool.status":
      string(op.name, L.DEFINITION_MAX_CHARS, "name");
      if (op.ownerAgentId !== undefined) string(op.ownerAgentId, L.ID_MAX_CHARS, "ownerAgentId");
      break;
    default:
      string(op.jobId, L.ID_MAX_CHARS, "jobId");
  }
  return op as unknown as EvaluationOperation;
}

/** Public alias used by the Desktop IPC validator. */
export function validateEvaluationOperation(value: unknown): void {
  parseEvaluationOperation(value);
}
