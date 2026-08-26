import {
  utf8ByteLength,
  type ClientError,
  type ConversationItem,
  type ConversationTranscriptPage,
  type ConversationTranscriptReadPage,
  type OpaqueCursor,
} from "@omp-studio/client-contract";

export const CONVERSATION_WINDOW_ITEM_LIMIT = 500;
export const CONVERSATION_WINDOW_BYTE_LIMIT = 8 * 1024 * 1024;

export type ConversationPhysicalPage = ConversationTranscriptPage | ConversationTranscriptReadPage;
/** A physical page shape whose `items` may contain several merged physical pages. */
export type ConversationWindow<TPage extends ConversationPhysicalPage> = TPage;

export class ConversationWindowError extends Error {
  readonly clientError: ClientError;

  constructor(clientError: ClientError) {
    super(clientError.message);
    this.name = "ConversationWindowError";
    this.clientError = clientError;
  }
}

function pageIdentity(page: ConversationPhysicalPage): string {
  return [
    page.sessionId,
    page.branchLeafId ?? "",
    page.headCursor,
    "runtimeEpoch" in page ? `runtime:${String(page.runtimeEpoch)}` : `archive:${page.transcriptRevision}`,
  ].join("\u0000");
}

/** A persisted user/system/boundary item owns the assistant/tool run that follows it. */
export function startsAtConversationBoundary(page: ConversationPhysicalPage): boolean {
  if (!page.hasMoreBefore) return true;
  const first = page.items[0];
  if (first === undefined) return false;
  return first.kind !== "message" || first.role !== "assistant";
}

function windowLimitError(items: number, bytes: number): ConversationWindowError {
  return new ConversationWindowError({
    code: "INVALID_ARGUMENT",
    message: `更早消息无法在完整轮次边界内加载（已达 ${items} 项 / ${Math.ceil(bytes / 1024)} KiB 上限）。`,
  });
}

function staleWindowError(): ConversationWindowError {
  return new ConversationWindowError({
    code: "CURSOR_STALE",
    message: "加载历史期间 transcript 已变化，请从最新页重试。",
  });
}

/**
 * Read physical pages until their oldest item is a semantic turn boundary.
 * Nothing is published while this function is in flight; callers submit the
 * returned page to the Client reducer exactly once.
 */
export async function readConversationWindow<TPage extends ConversationPhysicalPage>(
  newestPage: TPage,
  readOlder: (cursor: OpaqueCursor) => Promise<TPage>,
  budget: {
    readonly maxItems?: number;
    readonly maxBytes?: number;
  } = {},
): Promise<ConversationWindow<TPage>> {
  const identity = pageIdentity(newestPage);
  const pages: TPage[] = [newestPage];
  const cursors = new Set<string>();
  const itemBytes = new Map<string, number>();
  let itemCount = 0;
  let byteCount = 0;

  const account = (page: TPage) => {
    for (const item of page.items) {
      if (itemBytes.has(item.itemId)) continue;
      const bytes = utf8ByteLength(JSON.stringify(item));
      itemBytes.set(item.itemId, bytes);
      itemCount += 1;
      byteCount += bytes;
    }
    const maxItems = Math.min(CONVERSATION_WINDOW_ITEM_LIMIT, budget.maxItems ?? CONVERSATION_WINDOW_ITEM_LIMIT);
    const maxBytes = Math.min(CONVERSATION_WINDOW_BYTE_LIMIT, budget.maxBytes ?? CONVERSATION_WINDOW_BYTE_LIMIT);
    if (itemCount > maxItems || byteCount > maxBytes) {
      throw windowLimitError(itemCount, byteCount);
    }
  };

  account(newestPage);
  let oldest = newestPage;
  while (!startsAtConversationBoundary(oldest)) {
    const cursor = oldest.olderCursor;
    if (cursor === undefined || cursors.has(cursor)) throw staleWindowError();
    cursors.add(cursor);
    const page = await readOlder(cursor);
    if (pageIdentity(page) !== identity) throw staleWindowError();
    pages.push(page);
    account(page);
    oldest = page;
  }

  const seen = new Set<string>();
  const items: ConversationItem[] = [];
  for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
    for (const item of pages[pageIndex]!.items) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      items.push(item);
    }
  }
  const { olderCursor: _newestOlderCursor, ...newest } = newestPage;
  return {
    ...newest,
    items,
    ...(oldest.olderCursor === undefined ? {} : { olderCursor: oldest.olderCursor }),
    hasMoreBefore: oldest.hasMoreBefore,
  } as unknown as ConversationWindow<TPage>;
}

export function conversationWindowClientError(cause: unknown): ClientError | undefined {
  return cause instanceof ConversationWindowError ? cause.clientError : undefined;
}
