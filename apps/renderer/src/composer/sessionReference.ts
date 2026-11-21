import type { ConversationItem, HistoryEntryId, ThreadId, WorkspaceId } from "@omp-studio/client-contract";
import { referenceCodec } from "./referenceCodec";
import { newChipId, type ComposerChip } from "./types";

export type SessionReferenceSource = {
  readonly targetId: string | null;
  readonly workspaceId: WorkspaceId;
  readonly workspaceName?: string | undefined;
  readonly title?: string | undefined;
  readonly historyId?: HistoryEntryId | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly previewThreadId?: string | undefined;
};

export type SessionReferenceMessage = {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly truncated?: boolean;
};

export type SessionReference = {
  readonly sessionId: string;
  readonly source?: SessionReferenceSource | undefined;
  readonly matches?: readonly SessionReferenceSource[] | undefined;
  readonly messages: readonly SessionReferenceMessage[];
};

const SESSION_REFERENCE_TAG = "session-reference";
export const SESSION_REFERENCE_START = "<" + SESSION_REFERENCE_TAG + " ";
export const SESSION_REFERENCE_MESSAGE_LIMIT = 6;
const MESSAGE_CHAR_LIMIT = 1_000;

export function isSessionIdCandidate(text: string): boolean {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(text);
}

export function sessionSourceKey(source: SessionReferenceSource): string {
  return JSON.stringify([source.targetId, source.workspaceId, source.previewThreadId]);
}

export function sameSessionSource(left?: SessionReferenceSource, right?: SessionReferenceSource): boolean {
  return left === undefined || right === undefined ? left === right : sessionSourceKey(left) === sessionSourceKey(right);
}

/** Preserve quoted text while keeping native prompt directives inert. */
function quoteJson(value: unknown): string {
  return JSON.stringify(value).replace(/[@^+<]|\/(?=skill:)/gu, character =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

const codec = referenceCodec<{ sessionId: string; text: string }>(
  SESSION_REFERENCE_TAG,
  value => typeof value?.sessionId === "string" && value.sessionId.length > 0,
  quoteJson,
);

export function serializeSessionReference(reference: SessionReference): string {
  return codec.serialize({
    sessionId: reference.sessionId,
    text: reference.messages.length > 0 ? quoteJson(reference.messages) : "",
  });
}

export function nextSessionReference(text: string, from: number) {
  let cursor = from;
  for (let frame = codec.next(text, cursor); frame; frame = codec.next(text, cursor)) {
    cursor = frame.end;
    const { sessionId, text: body } = frame.reference;
    if (body.length === 0) return { start: frame.start, end: frame.end, reference: { sessionId, messages: [] } };
    try {
      const messages = JSON.parse(body) as SessionReferenceMessage[];
      if (Array.isArray(messages) && messages.length <= SESSION_REFERENCE_MESSAGE_LIMIT && messages.every(message =>
        (message?.role === "user" || message?.role === "assistant") && typeof message.text === "string",
      )) return {
        start: frame.start,
        end: frame.end,
        reference: { sessionId, messages: messages.map(({ role, text, truncated }) => ({
          role, text, ...(truncated === true && { truncated }),
        })) },
      };
    } catch {
      // A broken reference remains ordinary pasted text.
    }
  }
  return null;
}

export function sessionReferenceChip(reference: SessionReference, zh: boolean): ComposerChip {
  return {
    id: newChipId(),
    kind: "session",
    label: sessionReferenceLabel(reference, zh),
    sessionReference: reference,
  };
}

export function sessionReferenceLabel(reference: SessionReference, zh: boolean): string {
  return reference.source?.title || (zh ? "会话 " : "Session ") + reference.sessionId.slice(0, 8);
}

export function recentSessionMessages(items: readonly ConversationItem[]): SessionReferenceMessage[] {
  const messages: SessionReferenceMessage[] = [];
  for (let index = items.length - 1; index >= 0 && messages.length < SESSION_REFERENCE_MESSAGE_LIMIT; index--) {
    const item = items[index]!;
    if (item.kind === "resetBoundary") break;
    if (item.kind !== "message" || item.excludeFromContext || (item.role !== "user" && item.role !== "assistant")) continue;
    const textBlocks = item.content.filter(block => block.type === "text");
    const text = textBlocks.map(block => block.text).join("\n");
    if (!text.trim()) continue;
    const characters = Array.from(text);
    const truncated = characters.length > MESSAGE_CHAR_LIMIT || textBlocks.some(block => block.truncated);
    messages.push({
      role: item.role,
      text: characters.slice(0, MESSAGE_CHAR_LIMIT).join(""),
      ...(truncated && { truncated }),
    });
  }
  return messages.reverse();
}
