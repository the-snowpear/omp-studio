export type PredictionMethod = "off" | "auto" | "ngram" | "smollm" | "apple";
export interface PredictionSettings {
  method: PredictionMethod;
  effective: "off" | "ngram" | "smollm" | "apple";
  source: string;
  download: {
    state: "idle" | "downloading" | "ready" | "failed" | "cancelled";
    bytes: number;
    total: number;
    error?: string;
  };
}
export interface PredictionChannel {
  channelId: string;
  sessionId: string;
  expiresAt: number;
}
export type PredictionChannelOperation =
  | { kind: "prediction.status"; sessionId: string }
  | {
      kind: "prediction.configure";
      sessionId: string;
      method: PredictionMethod;
      scope: "session" | "global";
    }
  | { kind: "prediction.clearOverride"; sessionId: string }
  | { kind: "prediction.download.cancel"; sessionId: string }
  | { kind: "prediction.prepare"; sessionId: string }
  | { kind: "prediction.release"; sessionId: string; channelId: string };
export interface PredictionResultMap {
  "prediction.status": PredictionSettings;
  "prediction.configure": PredictionSettings;
  "prediction.clearOverride": PredictionSettings;
  "prediction.download.cancel": PredictionSettings;
  "prediction.prepare": PredictionChannel;
  "prediction.release": { released: true };
}
export const PREDICTION_KINDS = [
  "prediction.status",
  "prediction.configure",
  "prediction.clearOverride",
  "prediction.download.cancel",
  "prediction.prepare",
  "prediction.release",
] as const;
export function isPredictionKind(
  kind: string,
): kind is PredictionChannelOperation["kind"] {
  return (PREDICTION_KINDS as readonly string[]).includes(kind);
}
export type PredictionInput =
  | { kind: "update"; revision: number; text: string; caret: number }
  | { kind: "feedback"; revision: number; accepted: boolean }
  | { kind: "ping" }
  | { kind: "import"; requestId: string; transferId: string };
export type PredictionEvent =
  | {
      kind: "suggestion";
      channelId: string;
      revision: number;
      suffix: string | null;
    }
  | { kind: "error"; channelId: string; message: string; requestId?: string }
  | { kind: "closed"; channelId: string }
  | {
      kind: "imported";
      channelId: string;
      requestId: string;
      count: number;
      truncated: boolean;
    };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid prediction data");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024, empty = false): void {
  if (
    typeof value !== "string" ||
    (!empty && !value) ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error("Invalid prediction text");
}
function id(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error("Invalid prediction identity");
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  )
    throw new Error("Invalid prediction number");
}
export function validatePredictionChannelOperation(value: unknown): void {
  const row = object(value, [
    "kind",
    "sessionId",
    "method",
    "scope",
    "channelId",
  ]);
  if (typeof row.kind !== "string" || !isPredictionKind(row.kind))
    throw new Error("Unknown prediction command");
  text(row.sessionId, 128);
  if (row.kind === "prediction.configure") {
    if (
      !["off", "auto", "ngram", "smollm", "apple"].includes(
        row.method as string,
      ) ||
      !["session", "global"].includes(row.scope as string)
    )
      throw new Error("Invalid prediction settings");
  } else if (row.method !== undefined || row.scope !== undefined)
    throw new Error("Unexpected prediction setting");
  if (row.kind === "prediction.release") id(row.channelId);
  else if (row.channelId !== undefined)
    throw new Error("Unexpected prediction channel");
}
export function validatePredictionChannelResult(
  kind: PredictionChannelOperation["kind"],
  value: unknown,
): void {
  if (kind === "prediction.prepare") {
    const row = object(value, ["channelId", "sessionId", "expiresAt"]);
    id(row.channelId);
    text(row.sessionId, 128);
    integer(row.expiresAt);
    return;
  }
  if (kind === "prediction.release") {
    if (object(value, ["released"]).released !== true)
      throw new Error("Invalid prediction release");
    return;
  }
  const row = object(value, ["method", "effective", "source", "download"]);
  if (
    !["off", "auto", "ngram", "smollm", "apple"].includes(
      row.method as string,
    ) ||
    !["off", "ngram", "smollm", "apple"].includes(row.effective as string)
  )
    throw new Error("Invalid prediction method");
  text(row.source, 128);
  const download = object(row.download, ["state", "bytes", "total", "error"]);
  if (
    !["idle", "downloading", "ready", "failed", "cancelled"].includes(
      download.state as string,
    )
  )
    throw new Error("Invalid model download state");
  integer(download.bytes);
  integer(download.total);
  if (download.error !== undefined) text(download.error);
}
export function validatePredictionInput(
  value: unknown,
): asserts value is PredictionInput {
  const row = object(value, [
    "kind",
    "revision",
    "text",
    "caret",
    "accepted",
    "requestId",
    "transferId",
  ]);
  switch (row.kind) {
    case "update":
      integer(row.revision);
      text(row.text, 4096, true);
      integer(row.caret, (row.text as string).length);
      break;
    case "feedback":
      integer(row.revision);
      if (typeof row.accepted !== "boolean")
        throw new Error("Invalid prediction feedback");
      break;
    case "ping":
      break;
    case "import":
      id(row.requestId);
      id(row.transferId);
      break;
    default:
      throw new Error("Invalid prediction message");
  }
  const allowed =
    row.kind === "update"
      ? ["kind", "revision", "text", "caret"]
      : row.kind === "feedback"
        ? ["kind", "revision", "accepted"]
        : row.kind === "import"
          ? ["kind", "requestId", "transferId"]
          : ["kind"];
  object(value, allowed);
}
export function validatePredictionEvent(
  value: unknown,
): asserts value is PredictionEvent {
  const row = object(value, [
    "kind",
    "channelId",
    "revision",
    "suffix",
    "message",
    "requestId",
    "count",
    "truncated",
  ]);
  id(row.channelId);
  switch (row.kind) {
    case "suggestion":
      object(value, ["kind", "channelId", "revision", "suffix"]);
      integer(row.revision);
      if (row.suffix !== null) text(row.suffix, 256, true);
      break;
    case "error":
      object(value, ["kind", "channelId", "message", "requestId"]);
      text(row.message);
      if (row.requestId !== undefined) id(row.requestId);
      break;
    case "closed":
      object(value, ["kind", "channelId"]);
      break;
    case "imported":
      object(value, ["kind", "channelId", "requestId", "count", "truncated"]);
      id(row.requestId);
      integer(row.count, 2000);
      if (typeof row.truncated !== "boolean")
        throw new Error("Invalid prediction import result");
      break;
    default:
      throw new Error("Invalid prediction event");
  }
}
