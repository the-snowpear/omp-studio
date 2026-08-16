/**
 * Explicit RemoteInteractionRequest → ClientInteraction mapping.
 *
 * Title, sessionId and leaseGeneration are preserved; promptStyle is
 * dropped. `requestId` is optional: command-correlated interactions carry
 * it, Ask / tool-approval interactions do not. Approval details are reduced
 * to a bounded scalar record and redacted. Unknown kinds fail closed.
 */

import type {
  ClientInteraction,
  CommandRequestId,
  InteractionId,
  SessionId,
} from "@omp-studio/client-contract";
import type { RemoteInteractionRequest } from "@omp-studio/studio-protocol";

import { redactDetail } from "./read-models.js";

const APPROVAL_DETAIL_MAX_KEYS = 16;
const APPROVAL_DETAIL_MAX_CHARS = 240;
const APPROVAL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;
const APPROVAL_SENSITIVE = /token|secret|password|pid|process|endpoint|pipe|auth|bearer|credential/iu;

export function mapRemoteInteractionToClient(
  request: RemoteInteractionRequest,
  sessionId: SessionId,
  leaseGeneration: number,
  requestId?: CommandRequestId,
): ClientInteraction | undefined {
  const base = {
    interactionId: request.interactionId as InteractionId,
    sessionId,
    leaseGeneration,
    title: request.title,
    ...(requestId === undefined ? {} : { requestId }),
  };
  switch (request.kind) {
    case "confirm":
      return {
        ...base,
        kind: "confirm",
        message: request.message,
        destructive: request.destructive ?? false,
      };
    case "select":
      return {
        ...base,
        kind: "select",
        options: request.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        multiple: request.multiple ?? false,
      };
    case "input":
      return {
        ...base,
        kind: "input",
        ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
        secret: request.secret ?? false,
      };
    case "editor":
      return {
        ...base,
        kind: "editor",
        ...(request.content === undefined ? {} : { content: request.content }),
        ...(request.language === undefined ? {} : { language: request.language }),
      };
    case "approval":
      return {
        ...base,
        kind: "approval",
        approvalType: request.approvalType,
        detail: sanitizeApprovalDetail(request.details),
      };
    default:
      return undefined;
  }
}

export function sanitizeApprovalDetail(details: unknown): Record<string, unknown> {
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const record = details as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (Object.keys(out).length >= APPROVAL_DETAIL_MAX_KEYS) break;
    if (!APPROVAL_KEY.test(key) || APPROVAL_SENSITIVE.test(key)) continue;
    const value = record[key];
    if (typeof value === "string") {
      out[key] = value.slice(0, APPROVAL_DETAIL_MAX_CHARS);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return redactDetail(out);
}
