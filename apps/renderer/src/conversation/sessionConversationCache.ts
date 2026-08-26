import type { StateSnapshot } from "react-virtuoso";
import { timelineRowKey, type ConversationState, type TimelineRow } from "./conversationViewModel";

export const SESSION_CONVERSATION_CAPACITY = 5;
export const SESSION_CONVERSATION_BYTE_CAPACITY = 8 * 1024 * 1024;

export type SessionScrollAnchor = {
  readonly itemId: string;
  readonly offset: number;
};

export type SessionViewportSnapshot = {
  readonly atBottom: boolean;
  readonly anchor?: SessionScrollAnchor;
  readonly rowSignature: string;
  readonly firstItemIndex: number;
  readonly virtuosoState?: StateSnapshot;
};

export type SessionConversationSnapshot = {
  readonly rows: readonly TimelineRow[];
  readonly state?: ConversationState;
  readonly viewport?: SessionViewportSnapshot;
  readonly byteSize: number;
};

type CacheEntry = {
  rows: readonly TimelineRow[];
  state?: ConversationState;
  viewport?: SessionViewportSnapshot;
  byteSize: number;
};

const cache = new Map<string, CacheEntry>();
const rowSizeCache = new WeakMap<object, number>();
let totalBytes = 0;

function stringBytes(value: string | undefined): number {
  return value === undefined ? 0 : value.length * 2;
}

function rowBytes(row: TimelineRow): number {
  if (typeof row === "object") {
    const cached = rowSizeCache.get(row);
    if (cached !== undefined) return cached;
  }
  let bytes = 192 + stringBytes(timelineRowKey(row));
  if (row.type === "user") {
    bytes += stringBytes(row.text) + stringBytes(row.error) + stringBytes(row.requestId);
  } else if (row.type === "assistant") {
    for (const segment of row.segments) {
      if (segment.type === "text" || segment.type === "thinking") {
        bytes += 64 + stringBytes(segment.key) + stringBytes(segment.text);
        continue;
      }
      bytes += 64 + stringBytes(segment.key);
      for (const tool of segment.tools) {
        bytes += 160 + stringBytes(tool.toolCallId) + stringBytes(tool.toolName) + stringBytes(tool.output);
        if (tool.arguments !== undefined) bytes += stringBytes(JSON.stringify(tool.arguments));
        if (tool.result !== undefined) bytes += stringBytes(JSON.stringify(tool.result));
      }
    }
  } else if (row.type === "compaction") {
    bytes += stringBytes(row.item.summary) + stringBytes(row.item.shortSummary) + stringBytes(row.item.warning);
  }
  if (typeof row === "object") rowSizeCache.set(row, bytes);
  return bytes;
}

function rowsBytes(rows: readonly TimelineRow[]): number {
  let bytes = 64 + rows.length * 8;
  for (const row of rows) bytes += rowBytes(row);
  return bytes;
}

function touch(sessionId: string, entry: CacheEntry): void {
  cache.delete(sessionId);
  cache.set(sessionId, entry);
}

function evictToBudget(): void {
  while (cache.size > SESSION_CONVERSATION_CAPACITY || totalBytes > SESSION_CONVERSATION_BYTE_CAPACITY) {
    const oldestId = cache.keys().next().value;
    if (oldestId === undefined) break;
    const oldest = cache.get(oldestId);
    cache.delete(oldestId);
    totalBytes -= oldest?.byteSize ?? 0;
  }
}

export function timelineRowsSignature(rows: readonly TimelineRow[]): string {
  let signature = `${rows.length}`;
  for (const row of rows) {
    let contentLength = 0;
    if (row.type === "user") contentLength = row.text.length;
    if (row.type === "assistant") {
      for (const segment of row.segments) {
        if (segment.type === "text" || segment.type === "thinking") contentLength += segment.text.length;
        else for (const tool of segment.tools) contentLength += tool.output?.length ?? 0;
      }
    }
    signature += `|${timelineRowKey(row)}:${contentLength}`;
  }
  return signature;
}

export function rememberSessionConversation(
  sessionId: string,
  rows: readonly TimelineRow[],
  state?: ConversationState,
): void {
  if (sessionId.length === 0 || rows.length === 0) return;
  const byteSize = rowsBytes(rows);
  const previous = cache.get(sessionId);
  if (previous !== undefined) totalBytes -= previous.byteSize;
  if (byteSize > SESSION_CONVERSATION_BYTE_CAPACITY) {
    cache.delete(sessionId);
    return;
  }
  const entry: CacheEntry = {
    rows,
    byteSize,
    ...(state === undefined ? {} : { state }),
    ...(previous?.viewport === undefined ? {} : { viewport: previous.viewport }),
  };
  touch(sessionId, entry);
  totalBytes += byteSize;
  evictToBudget();
}

export function rememberSessionViewport(sessionId: string, viewport: SessionViewportSnapshot): void {
  const entry = cache.get(sessionId);
  if (entry === undefined) return;
  entry.viewport = viewport;
  touch(sessionId, entry);
}

export function recallSessionConversation(sessionId: string | undefined): SessionConversationSnapshot | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined;
  const entry = cache.get(sessionId);
  if (entry === undefined) return undefined;
  touch(sessionId, entry);
  return {
    rows: entry.rows,
    byteSize: entry.byteSize,
    ...(entry.state === undefined ? {} : { state: entry.state }),
    ...(entry.viewport === undefined ? {} : { viewport: entry.viewport }),
  };
}

export function forgetSessionConversation(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (entry !== undefined) totalBytes -= entry.byteSize;
  cache.delete(sessionId);
}

export function clearSessionConversationCache(): void {
  cache.clear();
  totalBytes = 0;
}

export function sessionConversationCacheStats(): { readonly entries: number; readonly bytes: number } {
  return { entries: cache.size, bytes: totalBytes };
}
