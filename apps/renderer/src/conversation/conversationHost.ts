import type { ClientState, ConversationHydrateClient, StudioClientImpl } from "@omp-studio/client";
import type {
  ClientError,
  ConversationTranscriptPage,
  ConversationTranscriptReadPage,
  OpaqueCursor,
  RuntimeEpoch,
  SessionId,
  StudioClient,
  Unsubscribe,
} from "@omp-studio/client-contract";
import { CONVERSATION_LIMITS, SESSION_TRANSCRIPT_READ_KIND } from "@omp-studio/client-contract";

export const TRANSCRIPT_QUERY_NAME = SESSION_TRANSCRIPT_READ_KIND;
export const ARCHIVE_TRANSCRIPT_QUERY_NAME = "session.transcript.readPage" as const;
export const TRANSCRIPT_PAGE_LIMIT = CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT;

export type ConversationIdentity = {
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly sessionId: SessionId;
  readonly transcriptRevision?: string;
};

/**
 * Official hydrate surface plus Impl-only state. Do not duck-type hydrate
 * methods; import `ConversationHydrateClient` from `@omp-studio/client`.
 */
export type ConversationClient = ConversationHydrateClient & {
  query: StudioClientImpl["query"];
  subscribe: StudioClientImpl["subscribe"];
  getState: () => Pick<ClientState, "conversation" | "commands">;
  onState: (listener: (state: Pick<ClientState, "conversation" | "commands">) => void) => Unsubscribe;
};

/** Typed view of StudioClientImpl. `getState` / `onState` stay Impl-only. */
export function asConversationClient(
  client: ConversationHydrateClient & {
    query: StudioClient["query"];
    subscribe: StudioClient["subscribe"];
    getState?: ConversationClient["getState"];
    onState?: ConversationClient["onState"];
  },
): ConversationClient | null {
  const { getState, onState } = client;
  if (getState === undefined || onState === undefined) return null;
  return client as ConversationClient;
}

export function asClientError(cause: unknown): ClientError {
  const value = cause as { code?: unknown; message?: unknown } | null;
  if (value && typeof value.code === "string" && typeof value.message === "string") {
    return { code: value.code as ClientError["code"], message: value.message };
  }
  return {
    code: "TRANSPORT_ERROR",
    message: cause instanceof Error && cause.message ? cause.message : "Unknown conversation client error",
  };
}

export function isStaleCursorError(error: { code?: string; message?: string }): boolean {
  if (error.code === "RESYNC_REQUIRED" || error.code === "STALE_EPOCH" || error.code === "INVALID_ARGUMENT") return true;
  return /stale|cursor/i.test(error.message ?? "");
}

export function identityKey(identity: ConversationIdentity | null): string {
  return identity
    ? `${identity.sessionId}:${identity.runtimeEpoch === undefined ? "archive" : String(identity.runtimeEpoch)}:${identity.transcriptRevision ?? ""}`
    : "";
}

export function sameIdentity(
  left: { runtimeEpoch?: RuntimeEpoch; sessionId: SessionId; transcriptRevision?: string } | null | undefined,
  right: { runtimeEpoch?: RuntimeEpoch; sessionId: SessionId; transcriptRevision?: string } | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (left.sessionId !== right.sessionId) return false;
  if (left.runtimeEpoch !== undefined && right.runtimeEpoch !== undefined && left.runtimeEpoch !== right.runtimeEpoch) return false;
  if (left.transcriptRevision !== undefined && right.transcriptRevision !== undefined && left.transcriptRevision !== right.transcriptRevision) return false;
  return true;
}

export function transcriptReadInput(cursor?: OpaqueCursor): { cursor?: OpaqueCursor; limit: number } {
  if (cursor === undefined) return { limit: TRANSCRIPT_PAGE_LIMIT };
  return { cursor, limit: TRANSCRIPT_PAGE_LIMIT };
}

export function archiveTranscriptReadInput(sessionId: SessionId, cursor?: OpaqueCursor): {
  sessionId: SessionId;
  cursor?: OpaqueCursor;
  limit: number;
} {
  return cursor === undefined ? { sessionId, limit: TRANSCRIPT_PAGE_LIMIT } : { sessionId, cursor, limit: TRANSCRIPT_PAGE_LIMIT };
}

export type { ConversationTranscriptPage, ConversationTranscriptReadPage };
