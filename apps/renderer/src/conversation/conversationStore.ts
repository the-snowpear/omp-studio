import type {
  ConversationItem,
  ConversationMessageItem,
  ConversationMessageError,
  ConversationRuntimeEvent,
  ConversationTranscriptPage,
  OpaqueCursor,
} from "@omp-studio/client-contract";
import { tailUtf8, truncateUtf8, utf8ByteLength } from "@omp-studio/client-contract";
import type { ComposerDoc } from "../composer/types";
import type { ConversationIdentity } from "./conversationHost";
import { buildPersistedTimeline, buildPersistedTimelineRow, buildTransientTimeline, emptyConversationState, tagTimelineStructure, type ConversationNotice, type ConversationState, type LiveMessage, type LiveTool, type PendingUser, type TimelineRow, type TimelineRowCache } from "./conversationViewModel";
import type { UserThumbMap } from "./userMessageThumbs";
import { capByImageBytes, docImageBytes, thumbsImageBytes } from "./userMessageThumbs";
import { getAppSettings, type StreamingCadenceHz } from "../settings/appSettings";

const DEFAULT_MAX_ROWS = 2_000;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const LIVE_BLOCK_MAX_BYTES = 256 * 1024;
const TOOL_OUTPUT_MAX_BYTES = 64 * 1024;
const NOTICE_LIMIT = 100;
const LIVE_MESSAGE_LIMIT = 16;
const LIVE_BLOCK_LIMIT = 64;
const LIVE_TOOL_LIMIT = 256;
const CADENCE_EPSILON_MS = 0.5;

type FrameHandle = number | ReturnType<typeof setTimeout>;
type FrameScheduler = { request(callback: () => void): FrameHandle; cancel(handle: FrameHandle): void; now?: () => number };
const defaultScheduler: FrameScheduler = typeof requestAnimationFrame === "function"
  ? { request: (callback) => requestAnimationFrame(callback), cancel: (handle) => cancelAnimationFrame(handle as number), now: () => performance.now() }
  : { request: (callback) => setTimeout(callback, 0), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() };

type MutableBlock = { readonly blockId: string; readonly blockType: "text" | "thinking"; text: string; pending: string[]; bytes: number; truncated: boolean };
type MutableMessage = { readonly messageId: string; readonly turnId: string; readonly role: "user" | "assistant" | "system"; readonly createdAt: string; readonly blocks: Map<string, MutableBlock>; aborted: boolean; dirty: boolean; materialized?: LiveMessage };

export type ConversationStoreSnapshot = { readonly state: ConversationState; readonly rows: readonly TimelineRow[] };
export type ConversationPage = Pick<ConversationTranscriptPage, "items" | "olderCursor" | "headCursor" | "hasMoreBefore">;
export type ConversationStoreTarget = { readonly sessionId: string; readonly agentId?: string };
export type ConversationStoreOptions = {
  readonly target: ConversationStoreTarget;
  readonly identity: ConversationIdentity | null;
  readonly generation: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
  readonly scheduler?: FrameScheduler;
  readonly streamingCadenceHz?: () => StreamingCadenceHz;
};

/** `ConversationItem` is immutable, so its byte size can be memoised per object.
 *  Without this, every completed message re-stringifies the whole hot window. */
const itemByteCache = new WeakMap<ConversationItem, number>();
function itemBytes(item: ConversationItem): number {
  const cached = itemByteCache.get(item);
  if (cached !== undefined) return cached;
  const bytes = utf8ByteLength(JSON.stringify(item));
  itemByteCache.set(item, bytes);
  return bytes;
}
function pageItems(items: readonly ConversationItem[], maxRows: number, maxBytes: number): { items: ConversationItem[]; trimmed: boolean } {
  let bytes = 0; let start = items.length;
  while (start > 0 && items.length - start < maxRows) {
    const next = itemBytes(items[start - 1]!);
    if (start < items.length && bytes + next > maxBytes) break;
    bytes += next; start -= 1;
  }
  return { items: items.slice(start), trimmed: start > 0 };
}

export class ConversationStore {
  private readonly listeners = new Set<() => void>();
  private readonly metadataListeners = new Set<() => void>();
  private readonly scheduler: FrameScheduler;
  private target: ConversationStoreTarget;
  private identity: ConversationIdentity | null;
  private readonly generation: number;
  private readonly maxRows: number;
  private readonly maxBytes: number;
  private readonly streamingCadenceHz: () => StreamingCadenceHz;
  private readonly rowCache: TimelineRowCache = new Map();
  private persistedRows: readonly TimelineRow[] = [];
  private persistedIds = new Set<string>();
  private persistedIndexes = new Map<string, number>();
  /** `persistedIds` is only refreshed when a frame is published, so it is stale
   *  for events applied earlier in the same animation frame (`message.completed`
   *  followed by `tool.started` is the common case). Membership questions asked
   *  between publishes go through `hasItem`, which rebuilds from `items` — a new
   *  array on every mutation — and then answers in O(1). */
  private itemIdCache: { readonly items: readonly ConversationItem[]; readonly ids: ReadonlySet<string> } | undefined;
  private persistedRowsDirty = true;
  private readonly dirtyPersistedRows = new Set<string>();
  private rowCachePruneRequired = false;
  private structureToken: object = {};
  private shapeToken: object = {};
  private items: ConversationItem[] = [];
  private liveMessages = new Map<string, MutableMessage>();
  private liveTools = new Map<string, LiveTool>();
  private liveToolsCache: { readonly [toolCallId: string]: LiveTool } | undefined;
  private liveOrder: string[] = [];
  private openTurnItems = new Map<string, string>();
  private messageErrors = new Map<string, ConversationMessageError>();
  private notices: ConversationNotice[] = [];
  private pendingUsers: PendingUser[] = [];
  private userDisplays: Record<string, PendingUser["doc"]> = {};
  private userThumbs: UserThumbMap = {};
  private olderCursor: OpaqueCursor | undefined;
  private headCursor: OpaqueCursor | undefined;
  private hasMoreBefore = false;
  private status: ConversationState["hydrateStatus"] = "idle";
  private unavailableReason: string | undefined;
  private error: ConversationState["error"] | undefined;
  private compacting: { readonly action: string } | undefined;
  private lastStreamSeq: number | undefined;
  private resyncRequired = false;
  private disposed = false;
  private frame: FrameHandle | undefined;
  private queuedStreaming = false;
  private queuedImmediate = false;
  private lastPublishedAt: number | undefined;
  private snapshot: ConversationStoreSnapshot;
  private metadataSnapshot: ConversationStoreSnapshot;
  private metadataDependencies: readonly unknown[] = [];

  constructor(options: ConversationStoreOptions) {
    this.target = options.target; this.identity = options.identity; this.generation = options.generation;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS; this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES; this.scheduler = options.scheduler ?? defaultScheduler;
    this.streamingCadenceHz = options.streamingCadenceHz ?? (() => getAppSettings().streamingCadenceHz);
    const state = { ...emptyConversationState(this.generation), identity: this.identity };
    this.snapshot = { state, rows: [] };
    this.metadataSnapshot = this.snapshot;
  }

  getSnapshot = (): ConversationStoreSnapshot => this.snapshot;
  getMetadataSnapshot = (): ConversationStoreSnapshot => this.metadataSnapshot;
  subscribe = (listener: () => void): (() => void) => { if (this.disposed) return () => {}; this.listeners.add(listener); return () => this.listeners.delete(listener); };
  subscribeMetadata = (listener: () => void): (() => void) => { if (this.disposed) return () => {}; this.metadataListeners.add(listener); return () => this.metadataListeners.delete(listener); };

  /** `liveTools` is projected into a plain object on every published frame.
   *  Route every write through these so the object is rebuilt only on change. */
  private setLiveTool(toolCallId: string, tool: LiveTool): void { this.liveTools.set(toolCallId, tool); this.liveToolsCache = undefined; }
  private deleteLiveTool(toolCallId: string): void { if (this.liveTools.delete(toolCallId)) this.liveToolsCache = undefined; }
  private clearLiveTools(): void { this.liveTools.clear(); this.liveToolsCache = undefined; }
  private liveToolsRecord(): { readonly [toolCallId: string]: LiveTool } {
    if (this.liveToolsCache === undefined) this.liveToolsCache = Object.fromEntries(this.liveTools);
    return this.liveToolsCache;
  }

  resolveTarget(sessionId: string): void {
    if (this.target.sessionId === sessionId) return;
    this.target = { ...this.target, sessionId };
    this.identity = { ...(this.identity ?? {}), sessionId: sessionId as ConversationIdentity["sessionId"] };
  }

  setLoading(resyncing = false): void { this.status = resyncing ? "resyncing" : "loading"; this.error = undefined; this.resyncRequired = false; this.publishNow(); }
  setUnavailable(reason: string): void { this.status = "unavailable"; this.unavailableReason = reason; this.publishNow(); }
  setError(error: { readonly code: string; readonly message: string }): void { this.status = "error"; this.error = error; this.publishNow(); }
  requireResync(reason: string): void { this.status = "resyncing"; this.resyncRequired = true; this.notices = [...this.notices.slice(-(NOTICE_LIMIT - 1)), { id: `resync:${this.generation}:${Date.now()}`, level: "warning", message: reason, source: "conversation" }]; this.publishNow(); }

  hydrate(page: ConversationPage, replay: readonly { readonly streamSeq: number; readonly update: ConversationRuntimeEvent }[] = [], watermark?: number): void {
    const bounded = pageItems(page.items, this.maxRows, this.maxBytes);
    this.items = bounded.items; this.olderCursor = page.olderCursor; this.headCursor = page.headCursor; this.hasMoreBefore = page.hasMoreBefore || bounded.trimmed;
    this.liveMessages.clear(); this.clearLiveTools(); this.liveOrder = []; this.openTurnItems.clear(); this.messageErrors.clear(); this.compacting = undefined;
    this.lastStreamSeq = undefined; this.status = "ready"; this.error = undefined; this.resyncRequired = false;
    this.markStructureChanged();
    this.trimAncillary();
    for (const event of replay) this.applyEventInternal(event.update, event.streamSeq);
    this.settlePendingFromItems();
    if (watermark !== undefined) this.lastStreamSeq = Math.max(this.lastStreamSeq ?? 0, watermark);
    this.publishNow();
  }

  prepend(page: ConversationPage): void {
    const existing = new Set(this.items.map((item) => item.itemId));
    const combined = [...page.items.filter((item) => !existing.has(item.itemId)), ...this.items];
    const bounded = pageItems(combined, this.maxRows, this.maxBytes);
    this.items = bounded.items; this.olderCursor = page.olderCursor; this.headCursor = this.headCursor ?? page.headCursor;
    // Once the hot window is full, retaining the newest live tail is more
    // important than repeatedly fetching pages that cannot fit in memory.
    this.hasMoreBefore = bounded.trimmed ? false : page.hasMoreBefore; this.markStructureChanged(); this.trimAncillary(); this.publishNow();
  }

  applyEvent(update: ConversationRuntimeEvent, streamSeq?: number): boolean {
    if (this.disposed || update.sessionId !== this.target.sessionId) return false;
    const eventAgentId = (update as ConversationRuntimeEvent & { readonly agentId?: string }).agentId;
    if (eventAgentId !== undefined && eventAgentId !== this.target.agentId) return false;
    if (streamSeq !== undefined && this.lastStreamSeq !== undefined && streamSeq <= this.lastStreamSeq) return false;
    this.applyEventInternal(update, streamSeq);
    this.queuePublish(update.kind === "conversation.message.delta" || update.kind === "conversation.tool.updated");
    return true;
  }

  private applyEventInternal(update: ConversationRuntimeEvent, streamSeq?: number): void {
    if (streamSeq !== undefined) this.lastStreamSeq = streamSeq;
    switch (update.kind) {
      case "conversation.message.started": {
        // An aborted/incomplete row is useful until the next turn begins, but
        // must not accumulate for the lifetime of a long session.
        for (const [id, previous] of this.liveMessages) {
          if (previous.turnId !== update.turnId) this.liveMessages.delete(id);
        }
        this.liveOrder = this.liveOrder.filter((id) => this.liveMessages.has(id));
        // Tools an aborted turn kept alive for its transient row die with that
        // row; without this they would linger until the LRU cap evicted them.
        for (const [id, tool] of this.liveTools) {
          if (!this.liveMessages.has(tool.messageId) && !this.hasItem(tool.messageId)) this.deleteLiveTool(id);
        }
        while (this.liveMessages.size >= LIVE_MESSAGE_LIMIT) {
          const oldest = this.liveMessages.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.liveMessages.delete(oldest);
          this.liveOrder = this.liveOrder.filter((id) => id !== oldest);
        }
        const message: MutableMessage = { messageId: update.messageId, turnId: update.turnId, role: update.role, createdAt: update.createdAt, blocks: new Map(), aborted: false, dirty: true };
        this.liveMessages.set(update.messageId, message); if (!this.liveOrder.includes(update.messageId)) this.liveOrder.push(update.messageId);
        const clearsPersistedErrors = update.role === "assistant" && this.messageErrors.size > 0;
        if (update.role === "assistant") this.messageErrors.clear();
        this.markStructureChanged(clearsPersistedErrors); break;
      }
      case "conversation.message.delta": {
        const message = this.liveMessages.get(update.messageId); if (message === undefined || message.turnId !== update.turnId) break;
        let block = message.blocks.get(update.blockId);
        if (block === undefined) {
          if (message.blocks.size >= LIVE_BLOCK_LIMIT) break;
          block = { blockId: update.blockId, blockType: update.blockType, text: "", pending: [], bytes: 0, truncated: false }; message.blocks.set(update.blockId, block);
        }
        if (block.blockType !== update.blockType || block.truncated) break;
        const room = LIVE_BLOCK_MAX_BYTES - block.bytes;
        if (room <= 0) { block.truncated = true; break; }
        const clipped = truncateUtf8(update.delta, room); const delta = clipped.text; if (delta.length > 0) { block.pending.push(delta); block.bytes += utf8ByteLength(delta); message.dirty = true; }
        if (clipped.truncated) block.truncated = true; break;
      }
      case "conversation.message.completed": {
        this.upsertItem(update.item); this.liveMessages.delete(update.messageId); this.liveOrder = this.liveOrder.filter((id) => id !== update.messageId); this.openTurnItems.set(update.item.itemId, update.turnId);
        if (update.error === undefined) this.messageErrors.delete(update.messageId); else this.messageErrors.set(update.messageId, update.error);
        if (update.item.role === "user") this.settlePending(update.item.itemId);
        this.markStructureChanged(); break;
      }
      case "conversation.tool.started": {
        while (this.liveTools.size >= LIVE_TOOL_LIMIT) {
          const oldest = this.liveTools.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.deleteLiveTool(oldest);
        }
        this.setLiveTool(update.toolCallId, { toolCallId: update.toolCallId, messageId: update.messageId, turnId: update.turnId, toolName: update.toolName, ...(update.arguments === undefined ? {} : { arguments: update.arguments }), status: "running" }); this.openTurnItems.set(update.messageId, update.turnId);
        this.markRowChanged(update.messageId); break;
      }
      case "conversation.tool.updated": {
        const tool = this.liveTools.get(update.toolCallId); if (tool === undefined || tool.turnId !== update.turnId) break;
        const candidate = update.updateMode === "replace" ? update.output ?? tool.output ?? "" : `${tool.output ?? ""}${update.output ?? ""}`;
        const tail = tailUtf8(candidate, TOOL_OUTPUT_MAX_BYTES);
        this.setLiveTool(update.toolCallId, { ...tool, output: tail.text, ...(update.truncated === true || tail.truncated ? { truncated: true } : {}) });
        if (this.hasItem(tool.messageId)) this.dirtyPersistedRows.add(tool.messageId);
        break;
      }
      case "conversation.tool.completed": {
        const tool = this.liveTools.get(update.toolCallId); if (tool !== undefined) {
          this.setLiveTool(update.toolCallId, { ...tool, result: update.result, status: update.result.isError ? "failed" : "succeeded" });
          this.markRowChanged(tool.messageId);
        }
        break;
      }
      case "conversation.turn.completed": this.closeTurn(update.turnId, false); this.finishResync(); break;
      case "conversation.turn.aborted": this.closeTurn(update.turnId, true); this.finishResync(); break;
      case "conversation.compaction.started": this.compacting = { action: update.action }; this.markStructureChanged(false); break;
      case "conversation.compaction.completed": if (update.item !== undefined) this.upsertItem(update.item); this.compacting = undefined; this.markStructureChanged(); break;
      case "conversation.notice": this.notices = [...this.notices.slice(-(NOTICE_LIMIT - 1)), { id: `notice:${this.generation}:${this.notices.length}`, level: update.level, message: update.message, ...(update.source === undefined ? {} : { source: update.source }) }]; break;
    }
  }

  private upsertItem(item: ConversationItem): void {
    const index = this.items.findIndex((current) => current.itemId === item.itemId);
    if (index < 0) this.items = [...this.items, item]; else if (this.items[index] !== item) { const next = this.items.slice(); next[index] = item; this.items = next; }
    const bounded = pageItems(this.items, this.maxRows, this.maxBytes); this.items = bounded.items; if (bounded.trimmed) this.hasMoreBefore = true; this.markStructureChanged(); this.trimAncillary();
  }
  private finishResync(): void {
    if (!this.resyncRequired) return;
    this.resyncRequired = false;
    this.status = "ready";
  }
  private closeTurn(turnId: string, aborted: boolean): void {
    let dropped = false;
    for (const [id, message] of this.liveMessages) if (message.turnId === turnId) { message.aborted = aborted; message.dirty = true; if (!aborted) { this.liveMessages.delete(id); dropped = true; } }
    // `message.completed` prunes `liveOrder` itself; a completed turn must do
    // the same or the order array keeps one dead id per turn and is walked on
    // every published frame.
    if (dropped) this.liveOrder = this.liveOrder.filter((id) => this.liveMessages.has(id));
    const turnTools = [...this.liveTools.values()].filter((tool) => tool.turnId === turnId);
    // Settled results are folded for an aborted turn too: a tool that finished
    // before the abort is real history, and dropping its live entry without
    // folding leaves the persisted row rendering that call as `missing`.
    if (turnTools.length > 0) {
      const byMessage = new Map<string, LiveTool[]>();
      for (const tool of turnTools) { const list = byMessage.get(tool.messageId) ?? []; list.push(tool); byMessage.set(tool.messageId, list); }
      this.items = this.items.map((item) => {
        if (item.kind !== "message") return item; const tools = byMessage.get(item.itemId); if (tools === undefined) return item;
        const resultIds = new Set(item.content.filter((block) => block.type === "toolResult").map((block) => block.toolCallId));
        const results = tools.flatMap((tool) => tool.result !== undefined && !resultIds.has(tool.toolCallId) ? [tool.result] : []);
        return results.length === 0 ? item : { ...item, content: [...item.content, ...results] };
      });
    }
    for (const [id, tool] of this.liveTools) {
      if (tool.turnId !== turnId) continue;
      // An aborted turn keeps its live row on screen until the next turn opens,
      // so tools owned by that still-live row must stay addressable there —
      // only their non-terminal status is settled. Everything else is either
      // folded into a persisted item above or orphaned, and can go.
      if (!aborted || this.hasItem(tool.messageId) || !this.liveMessages.has(tool.messageId)) { this.deleteLiveTool(id); continue; }
      if (tool.status === "running" || tool.status === "queued") this.setLiveTool(id, { ...tool, status: "aborted" });
    }
    for (const [itemId, owner] of this.openTurnItems) if (owner === turnId) this.openTurnItems.delete(itemId);
    this.markStructureChanged();
    this.trimAncillary();
  }
  /**
   * Settle every turn the client still holds open, with `turn.aborted` semantics.
   *
   * The Runtime parks a logical turn on `agent_end{isTerminal: false}` (a
   * retryable provider error schedules a continuation) and closes it only from
   * the terminal `agent_end` that continuation produces. A user abort supersedes
   * the continuation, so that close event never arrives: `openTurnItems` and the
   * folded tools would keep the tail reading as live — `working` pinned on the
   * activity line, the stop button armed, `subagentTurnRunning` true — until the
   * store is rebuilt by a session switch. Called when the Runtime reports idle.
   */
  settleOpenTurns(): boolean {
    const turnIds = new Set<string>();
    for (const message of this.liveMessages.values()) turnIds.add(message.turnId);
    for (const tool of this.liveTools.values()) turnIds.add(tool.turnId);
    for (const turnId of this.openTurnItems.values()) turnIds.add(turnId);
    if (turnIds.size === 0) return false;
    for (const turnId of turnIds) this.closeTurn(turnId, true);
    this.publishNow();
    return true;
  }
  private settlePending(itemId: string): void {
    const index = this.pendingUsers.findIndex((pending) => !pending.knownItemIds.includes(itemId));
    const settled = index >= 0 ? index : this.pendingUsers.findIndex((pending) => pending.status === "pending"); if (settled < 0) return;
    const pending = this.pendingUsers[settled]!; this.pendingUsers = this.pendingUsers.filter((_, current) => current !== settled);
    if (pending.doc !== undefined) this.userDisplays = { ...this.userDisplays, [itemId]: pending.doc };
    this.markStructureChanged();
  }

  /** Reconcile an optimistic row when hydrate or command acceptance won the
   * race and the authoritative user item is already present in the store. */
  private settlePendingFromItems(): void {
    if (this.pendingUsers.length === 0) return;
    const available = this.items.filter((item): item is ConversationMessageItem => item.kind === "message" && item.role === "user");
    const remaining: PendingUser[] = [];
    let changed = false;
    for (const pending of this.pendingUsers) {
      const index = available.findIndex((item) => !pending.knownItemIds.includes(item.itemId));
      if (index < 0) {
        remaining.push(pending);
        continue;
      }
      const [item] = available.splice(index, 1);
      if (pending.doc !== undefined && item !== undefined) this.userDisplays = { ...this.userDisplays, [item.itemId]: pending.doc };
      changed = true;
    }
    if (!changed) return;
    this.pendingUsers = remaining;
    this.markStructureChanged();
  }

  private trimAncillary(): void {
    const visible = new Set(this.items.map((item) => item.itemId));
    this.pendingUsers = this.pendingUsers.slice(-100);
    // 条数上限之外还要有字节上限：这两张表携带的是原图 base64，光靠 2000 条的条数
    // 上限，几十张 4K 截图就能吃掉 GB 级内存。见 `USER_IMAGE_BUDGET_BYTES`。
    this.userDisplays = Object.fromEntries(
      capByImageBytes(
        Object.entries(this.userDisplays)
          // `PendingUser["doc"]` 是可选的，所以这张表的值类型带 undefined；
          // 记账函数只认真实的 doc。
          .filter((entry): entry is [string, ComposerDoc] => entry[1] !== undefined && visible.has(entry[0]))
          .slice(-this.maxRows),
        docImageBytes,
      ),
    );
    this.userThumbs = Object.fromEntries(
      capByImageBytes(
        Object.entries(this.userThumbs).filter(([itemId]) => visible.has(itemId)).slice(-this.maxRows),
        thumbsImageBytes,
      ),
    );
    this.rowCachePruneRequired = true;
    // `openTurnItems` 只在精确 turnId 匹配时删（见 `closeTurn`），abort / resync /
    // runtime 丢失漏掉的那些会永久留存，而 `state()` 每帧对它做 `Object.fromEntries`。
    // 跟着可见窗口一起裁。
    for (const itemId of this.openTurnItems.keys()) {
      if (!visible.has(itemId) && !this.liveMessages.has(itemId)) this.openTurnItems.delete(itemId);
    }
  }
  private markStructureChanged(persisted = true): void {
    if (persisted) { this.persistedRowsDirty = true; this.dirtyPersistedRows.clear(); }
    this.rowCachePruneRequired = true;
    this.structureToken = {};
    // 行序列真的变了才动 shape：只按行 type 分组的派生结果（`renderItems`）依赖它。
    this.shapeToken = {};
  }
  private hasItem(itemId: string): boolean {
    if (this.itemIdCache === undefined || this.itemIdCache.items !== this.items) {
      this.itemIdCache = { items: this.items, ids: new Set(this.items.map((item) => item.itemId)) };
    }
    return this.itemIdCache.ids.has(itemId);
  }
  /**
   * A tool event changes one row's content, never the timeline's shape.
   *
   * `markStructureChanged(true)` would drop the dirty set and re-project the
   * whole bounded window (up to `maxRows` rows) for every tool start and
   * completion; marking the owning row keeps that rebuild proportional to the
   * one row that actually changed. The structure token still advances so the
   * transcript's per-structure memos (`renderItems`, plan/change binds) see the
   * new tool set.
   */
  private markRowChanged(itemId: string): void {
    if (this.hasItem(itemId)) this.dirtyPersistedRows.add(itemId);
    this.rowCachePruneRequired = true;
    this.structureToken = {};
  }
  private pruneRowCache(): void {
    if (!this.rowCachePruneRequired) return;
    const active = new Set(this.items.map((item) => item.itemId));
    for (const messageId of this.liveMessages.keys()) active.add(messageId);
    for (const pending of this.pendingUsers) active.add(`pending:${pending.requestId}`);
    if (this.compacting !== undefined) active.add("compacting");
    for (const key of this.rowCache.keys()) if (!active.has(key)) this.rowCache.delete(key);
    this.rowCachePruneRequired = false;
  }
  trackPending(pending: PendingUser): void { this.pendingUsers = [...this.pendingUsers.filter((item) => item.requestId !== pending.requestId), pending].slice(-100); this.settlePendingFromItems(); this.markStructureChanged(false); this.publishNow(); }
  failPending(requestId: string, error: string): void { this.pendingUsers = this.pendingUsers.map((item) => item.requestId === requestId ? { ...item, status: "failed", error } : item); this.publishNow(); }
  dropPending(requestId: string): void { this.pendingUsers = this.pendingUsers.filter((item) => item.requestId !== requestId); this.markStructureChanged(false); this.publishNow(); }
  restoreFromUser(itemId: string): boolean {
    const index = this.items.findIndex((item) => item.itemId === itemId && item.kind === "message" && item.role === "user"); if (index < 0) return false;
    this.items = this.items.slice(0, index); this.markStructureChanged(); this.trimAncillary(); this.publishNow(); return true;
  }
  setUserThumbs(thumbs: UserThumbMap): void { this.userThumbs = thumbs; this.markStructureChanged(); this.trimAncillary(); this.publishNow(); }
  getOlderCursor(): OpaqueCursor | undefined { return this.olderCursor; }

  private materializeMessages(): Record<string, LiveMessage> {
    const result: Record<string, LiveMessage> = {};
    for (const message of this.liveMessages.values()) {
      if (message.materialized === undefined || message.dirty) {
        message.materialized = { messageId: message.messageId, turnId: message.turnId, role: message.role, createdAt: message.createdAt, blocks: [...message.blocks.values()].map((block) => {
          if (block.pending.length > 0) {
            block.text += block.pending.join("");
            block.pending = [];
          }
          return { blockId: block.blockId, blockType: block.blockType, text: block.text, ...(block.truncated ? { truncated: true } : {}) };
        }), aborted: message.aborted };
        message.dirty = false;
      }
      result[message.messageId] = message.materialized;
    }
    return result;
  }
  private state(): ConversationState {
    return { generation: this.generation, identity: this.identity, items: this.items, liveMessages: this.materializeMessages(), liveTools: this.liveToolsRecord(), liveOrder: this.liveOrder, ...(this.olderCursor === undefined ? {} : { olderCursor: this.olderCursor }), ...(this.headCursor === undefined ? {} : { headCursor: this.headCursor }), hasMoreBefore: this.hasMoreBefore, hydrateStatus: this.status, ...(this.unavailableReason === undefined ? {} : { unavailableReason: this.unavailableReason }), ...(this.error === undefined ? {} : { error: this.error }), notices: this.notices, pendingUsers: this.pendingUsers, ...(this.lastStreamSeq === undefined ? {} : { lastEventSeq: this.lastStreamSeq }), resyncRequired: this.resyncRequired, userDisplays: this.userDisplays as Record<string, ComposerDoc>, userThumbs: this.userThumbs, openTurnItems: Object.fromEntries(this.openTurnItems), ...(this.compacting === undefined ? {} : { compacting: this.compacting }), messageErrors: Object.fromEntries(this.messageErrors) };
  }
  private queuePublish(streaming = false): void {
    if (this.disposed) return;
    this.queuedStreaming ||= streaming;
    this.queuedImmediate ||= !streaming;
    if (this.frame !== undefined) return;
    this.frame = this.scheduler.request(() => {
      this.frame = undefined;
      const immediate = this.queuedImmediate;
      const streamingOnly = this.queuedStreaming && !immediate;
      this.queuedStreaming = false;
      this.queuedImmediate = false;
      if (streamingOnly) {
        const now = this.scheduler.now?.() ?? Date.now();
        const minInterval = 1000 / this.streamingCadenceHz();
        if (this.lastPublishedAt !== undefined && now - this.lastPublishedAt + CADENCE_EPSILON_MS < minInterval) {
          this.queuedStreaming = true;
          this.queuePublish(true);
          return;
        }
      }
      this.publishNow();
    });
  }
  private publishNow(): void {
    if (this.disposed) return; if (this.frame !== undefined) { this.scheduler.cancel(this.frame); this.frame = undefined; }
    this.queuedStreaming = false; this.queuedImmediate = false;
    this.lastPublishedAt = this.scheduler.now?.() ?? Date.now();
    const state = this.state();
    this.pruneRowCache();
    if (this.persistedRowsDirty) {
      this.persistedIds = new Set(state.items.map((item) => item.itemId));
      this.persistedIndexes = new Map(state.items.map((item, index) => [item.itemId, index]));
      this.persistedRows = buildPersistedTimeline(state, this.rowCache);
      this.persistedRowsDirty = false;
      this.dirtyPersistedRows.clear();
    } else if (this.dirtyPersistedRows.size > 0) {
      const next = this.persistedRows.slice();
      for (const itemId of this.dirtyPersistedRows) {
        const index = this.persistedIndexes.get(itemId); const item = index === undefined ? undefined : state.items[index];
        if (index !== undefined && item !== undefined) next[index] = buildPersistedTimelineRow(state, item, this.rowCache);
      }
      this.persistedRows = next;
      this.dirtyPersistedRows.clear();
    }
    const transientRows = buildTransientTimeline(state, this.persistedIds, this.rowCache);
    // Idle transcripts publish the persisted prefix by reference. Only a live
    // tail forces a copy, and then only because `rows` must stay one array.
    const rows = tagTimelineStructure(transientRows.length === 0 ? this.persistedRows : [...this.persistedRows, ...transientRows], this.structureToken, this.shapeToken);
    this.snapshot = { state, rows };
    const metadataDependencies: readonly unknown[] = [state.identity, state.items, state.olderCursor, state.headCursor, state.hasMoreBefore, state.hydrateStatus, state.unavailableReason, state.error, state.notices, state.pendingUsers, state.resyncRequired, state.userDisplays, state.userThumbs, state.compacting];
    const metadataChanged = metadataDependencies.length !== this.metadataDependencies.length || metadataDependencies.some((value, index) => value !== this.metadataDependencies[index]);
    if (metadataChanged) { this.metadataDependencies = metadataDependencies; this.metadataSnapshot = this.snapshot; for (const listener of this.metadataListeners) listener(); }
    for (const listener of this.listeners) listener();
  }
  /**
   * Release every buffer the store owns, including the published snapshots.
   *
   * Clearing the working fields is not enough on its own: `snapshot` and
   * `metadataSnapshot` keep the last `state`/`rows` alive, so a store that is
   * still referenced anywhere would hold a whole transcript window through
   * them. `getSnapshot` stays callable after dispose (a render can race an
   * unmount), so they are replaced with an empty snapshot rather than dropped —
   * identity and generation are preserved so a stray read still reads as "this
   * conversation, empty" instead of a null identity.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) this.scheduler.cancel(this.frame);
    this.frame = undefined;
    this.listeners.clear(); this.metadataListeners.clear();
    this.liveMessages.clear(); this.clearLiveTools(); this.rowCache.clear();
    this.liveOrder = []; this.openTurnItems.clear(); this.messageErrors.clear();
    this.items = []; this.persistedRows = []; this.notices = []; this.pendingUsers = []; this.userDisplays = {}; this.userThumbs = {};
    this.persistedIds = new Set(); this.persistedIndexes.clear(); this.dirtyPersistedRows.clear();
    this.itemIdCache = undefined;
    this.compacting = undefined;
    this.queuedStreaming = false; this.queuedImmediate = false; this.lastPublishedAt = undefined;
    const empty: ConversationStoreSnapshot = { state: { ...emptyConversationState(this.generation), identity: this.identity }, rows: [] };
    this.snapshot = empty; this.metadataSnapshot = empty; this.metadataDependencies = [];
  }
}
