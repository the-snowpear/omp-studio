import { selectConversationHydrate, selectConversationViews } from "@omp-studio/client";
import {
  utf8ByteLength,
  type ClientEvent,
  type ConversationItem,
  type ConversationRuntimeEvent,
  type ConversationTranscriptPage,
  type ConversationTranscriptReadPage,
  type OpaqueCursor,
} from "@omp-studio/client-contract";
import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import {
  asClientError,
  identityKey,
  isStaleCursorError,
  sameIdentity,
  archiveTranscriptReadInput,
  transcriptReadInput,
} from "./conversationHost";
import {
  CONVERSATION_WINDOW_BYTE_LIMIT,
  CONVERSATION_WINDOW_ITEM_LIMIT,
  conversationWindowClientError,
  readConversationWindow,
  type ConversationPhysicalPage,
  type ConversationWindow,
} from "./conversationWindow";
import { forgetSessionConversation } from "./sessionConversationCache";
import {
  absorbPendingDisplays,
  applyLiveEvent,
  buildTimeline,
  dropPending,
  emptyConversationState,
  failPending,
  persistedItemsOf,
  projectClientConversation,
  resetConversation,
  ConversationRowsProjector,
  trackPending,
  type ConversationState,
  type HydrateStatus,
  type PendingUser,
  type TimelineRow,
} from "./conversationViewModel";
import { reuseTimelineRows } from "./rowReuse";
import type { ComposerDoc } from "../composer/types";
import type { ConversationCommitPriority } from "./conversationCommitGate";
import {
  getDefaultThumbStore,
  mergeThumbMaps,
  thumbsFromDoc,
  thumbsFromDisplays,
  type UserThumbMap,
  type UserThumbStore,
} from "./userMessageThumbs";

export type ConversationEngineInput = {
  readonly preview: boolean;
  readonly client: ConversationClient | null;
  readonly identity: ConversationIdentity | null;
  readonly canRead: boolean;
  readonly runtimeConnected: boolean;
  readonly previewItems: readonly ConversationItem[];
  readonly previewLive?: readonly ConversationRuntimeEvent[];
  /**
   * 上一次渲染这条会话时的行，用作 `reuseTimelineRows` 的比较基线：切回同一个会话时
   * 没变的行沿用旧对象，`ConversationItemView` / `MarkdownText` 的 `memo` 才能命中，
   * 恢复出来的正文不必重新解析一遍。
   */
  readonly initialRows?: readonly TimelineRow[];
  /**
   * 返回 true 表示这条会话正在激活（`session.resume` 在飞）：先不读归档页，等
   * Runtime 快照补上 `runtimeEpoch` 后由新的 engine 直接读 live 页，一次切换只读一遍。
   */
  readonly deferHydrate?: () => boolean;
  /** Injected in tests. Production uses IndexedDB (memory fallback). */
  readonly thumbStore?: UserThumbStore;
};

export type ConversationSnapshot = {
  readonly state: ConversationState;
  readonly rows: readonly TimelineRow[];
  readonly demo: boolean;
  readonly loadingOlder: boolean;
  readonly identityKey: string;
};

export type ConversationEngine = {
  getSnapshot(): ConversationSnapshot;
  subscribe(listener: (priority?: ConversationCommitPriority) => void): () => void;
  start(): void;
  dispose(): void;
  loadOlder(): Promise<void>;
  /** Re-hydrate the active branch. `session.tree.navigate` does not emit conversation live events. */
  reload(): Promise<void>;
  /** Preview-only: drop the target user row and everything after it. */
  restoreFromUser(itemId: string): boolean;
  trackPending(pending: PendingUser): void;
  failPending(requestId: string, error: string): void;
  dropPending(requestId: string): void;
};

function unavailableReason(input: ConversationEngineInput): string | undefined {
  if (input.preview) return undefined;
  if (input.identity === null) return "当前没有活动会话。";
  if (!input.canRead) return "当前 Host 不支持 session.history 或持久化 transcript 读取。";
  if (input.client === null) return "当前 Client 未提供 transcript hydrate。";
  return undefined;
}

function conversationOf(client: ConversationClient) {
  try {
    return client.getState()?.conversation;
  } catch {
    return undefined;
  }
}

export function createConversationEngine(input: ConversationEngineInput): ConversationEngine {
  let previewState: ConversationState = emptyConversationState();
  let pendingUsers: readonly PendingUser[] = [];
  let userDisplays: { readonly [itemId: string]: ComposerDoc } = {};
  let userThumbs: UserThumbMap = {};
  const thumbStore = input.thumbStore ?? getDefaultThumbStore();
  let loadingOlder = false;
  let disposed = false;
  let hydrateInFlight = false;
  const hydrateWaiters: Array<() => void> = [];
  let unsubEvent: (() => void) | undefined;
  let unsubState: (() => void) | undefined;
  const listeners = new Set<(priority?: ConversationCommitPriority) => void>();
  let snapshotCache: ConversationSnapshot | null = null;
  let snapshotCacheConvo: ReturnType<typeof conversationOf> | undefined;
  let snapshotCachePending = pendingUsers;
  let snapshotCacheDisplays = userDisplays;
  let snapshotCacheThumbs = userThumbs;
  let snapshotCacheLoadingOlder = false;
  let snapshotCachePreview: ConversationState | null = null;
  const rowsProjector = new ConversationRowsProjector();
  /** 切回同一会话时的行复用基线，直到本 engine 自己产出第一份快照。 */
  const reuseBaseline: readonly TimelineRow[] = input.initialRows ?? [];
  /**
   * 缩略图（IndexedDB）读取。hydrate 提交前等它一把：它和 transcript 查询同时起跑，
   * 通常早就落地，这样恢复的用户气泡在第一帧就带着缩略图，不用为它再提交一次。
   */
  let thumbsLoaded: Promise<void> = Promise.resolve();

  const readTypedLogicalWindow = async <TPage extends ConversationPhysicalPage>(
    queryPage: (cursor?: OpaqueCursor) => Promise<TPage>,
    firstCursor?: OpaqueCursor,
    budget?: { readonly maxItems?: number; readonly maxBytes?: number },
  ): Promise<ConversationWindow<TPage>> => {
    let lastError: unknown;
    const attempts = firstCursor === undefined ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const first = await queryPage(firstCursor);
        if (input.identity === null || !sameIdentity(first, input.identity)) {
          throw { code: "STALE_EPOCH", message: "Transcript identity changed while loading the selected session" };
        }
        return await readConversationWindow(first, async (cursor) => {
          const page = await queryPage(cursor);
          return page;
        }, budget);
      } catch (cause) {
        lastError = cause;
        const error = conversationWindowClientError(cause) ?? asClientError(cause);
        const retryableLatestDrift = error.code === "CURSOR_STALE" || error.code === "RESYNC_REQUIRED";
        if (attempt + 1 >= attempts || !retryableLatestDrift) throw cause;
      }
    }
    throw lastError;
  };

  const readArchiveWindow = (
    firstCursor?: OpaqueCursor,
    budget?: { readonly maxItems?: number; readonly maxBytes?: number },
  ): Promise<ConversationWindow<ConversationTranscriptReadPage>> => {
    if (input.client === null || input.identity === null) return Promise.reject(new Error("conversation client unavailable"));
    return readTypedLogicalWindow(
      (cursor) => input.client!.query(
        "session.transcript.readPage",
        archiveTranscriptReadInput(input.identity!.sessionId, cursor),
      ),
      firstCursor,
      budget,
    );
  };

  const readLiveWindow = (
    firstCursor?: OpaqueCursor,
    budget?: { readonly maxItems?: number; readonly maxBytes?: number },
  ): Promise<ConversationWindow<ConversationTranscriptPage>> => {
    if (input.client === null) return Promise.reject(new Error("conversation client unavailable"));
    return readTypedLogicalWindow(
      (cursor) => input.client!.query("session.transcript.read", transcriptReadInput(cursor)),
      firstCursor,
      budget,
    );
  };

  const releaseHydrateWaiters = () => {
    const waiters = hydrateWaiters.splice(0);
    for (const waiter of waiters) waiter();
  };

  const waitHydrateIdle = async () => {
    while (hydrateInFlight && !disposed) {
      await new Promise<void>((resolve) => {
        hydrateWaiters.push(resolve);
      });
    }
  };

  const emit = (priority: ConversationCommitPriority = "normal") => {
    for (const listener of listeners) listener(priority);
  };

  const setPreviewState = (next: ConversationState) => {
    previewState = next;
    emit();
  };

  const readLatest = async () => {
    if (input.preview || input.client === null || input.identity === null || disposed || hydrateInFlight) return;
    const archiveRead = input.identity.runtimeEpoch === undefined && input.client.hydrateArchiveTranscript !== undefined;
    if (archiveRead && input.deferHydrate?.() === true) {
      // 会话正在激活：epoch 落地后新的 engine 直接读 live 页。这里只把状态标成
      // loading，既不读归档（同一次切换会读两遍），也不让 onClientState 反复重试。
      input.client.beginTranscriptHydrate(input.identity);
      emit();
      return;
    }
    hydrateInFlight = true;
    const gen = input.client.beginTranscriptHydrate(input.identity);
    emit();
    try {
      if (archiveRead && input.client.hydrateArchiveTranscript !== undefined) {
        const page = await readArchiveWindow();
        if (disposed) return;
        // 缩略图与本次查询同时起跑，通常早已落地：和 hydrate 一起提交，避免它单独
        // 触发一次提交把所有用户行重建一遍。
        await thumbsLoaded;
        if (disposed) return;
        input.client.hydrateArchiveTranscript(page, gen);
      } else {
        const page = await readLiveWindow();
        if (disposed) return;
        await thumbsLoaded;
        if (disposed) return;
        input.client.hydrateTranscript(page, gen);
      }
    } catch (cause) {
      if (disposed) return;
      input.client.failTranscriptHydrate(conversationWindowClientError(cause) ?? asClientError(cause), gen);
    } finally {
      hydrateInFlight = false;
      emit("terminal");
      releaseHydrateWaiters();
      // A resident session resume can change the Runtime identity while this
      // read is in flight. The client deliberately clears conversation state
      // and advances its hydrate generation, so the stale page above is
      // ignored. Start one fresh read for the still-selected session instead
      // of leaving the surface permanently idle.
      const convo = conversationOf(input.client);
      if (
        !disposed &&
        convo?.hydrateStatus === "idle" &&
        convo.hydrateGeneration !== gen &&
        (convo.identity === undefined || sameIdentity(convo.identity, input.identity))
      ) {
        void readLatest();
      }
    }
  };

  const onRuntimeEvent = (event: ClientEvent) => {
    if (disposed) return;
    if (event.kind === "resync.required") {
      if (input.identity !== null) forgetSessionConversation(input.identity.sessionId);
      void readLatest();
      return;
    }
    if (event.kind !== "conversation.changed") return;
    if (event.update.sessionId !== input.identity?.sessionId) return;
    const kind = event.update.kind;
    if (
      kind === "conversation.message.completed" ||
      kind === "conversation.tool.completed" ||
      kind === "conversation.turn.completed" ||
      kind === "conversation.turn.aborted" ||
      kind === "conversation.compaction.completed"
    ) emit("terminal");
  };

  const rememberThumbs = (previous: { readonly [itemId: string]: ComposerDoc }, next: { readonly [itemId: string]: ComposerDoc }) => {
    const sessionId = input.identity?.sessionId;
    if (sessionId === undefined || input.preview) return;
    for (const [itemId, doc] of Object.entries(next)) {
      if (previous[itemId] === doc) continue;
      const thumbs = thumbsFromDoc(doc);
      if (thumbs.length === 0) continue;
      userThumbs = mergeThumbMaps(userThumbs, { [itemId]: thumbs });
      void thumbStore.save(sessionId, itemId, thumbs).catch(() => {});
    }
  };

  const absorbPending = (items: readonly ConversationItem[]) => {
    const previous = userDisplays;
    const absorbed = absorbPendingDisplays(pendingUsers, items, userDisplays);
    pendingUsers = absorbed.pending;
    userDisplays = absorbed.displays;
    userThumbs = mergeThumbMaps(userThumbs, thumbsFromDisplays(absorbed.displays));
    rememberThumbs(previous, absorbed.displays);
    return absorbed;
  };

  const onClientState = () => {
    if (disposed || input.client === null) return;
    const convo = conversationOf(input.client);
    if (convo === undefined) return;
    absorbPending(persistedItemsOf(convo));
    if (
      convo.hydrateStatus === "idle" &&
      !hydrateInFlight &&
      (convo.identity === undefined || sameIdentity(convo.identity, input.identity))
    ) {
      void readLatest();
      return;
    }
    if (convo.resyncRequired && convo.hydrateStatus === "ready" && !hydrateInFlight) {
      void readLatest();
    }
    emit();
  };

  const readSnapshot = (): ConversationSnapshot => {
    if (input.preview) {
      if (
        snapshotCache !== null &&
        snapshotCachePreview === previewState &&
        snapshotCacheLoadingOlder === loadingOlder
      ) {
        return snapshotCache;
      }
      const snapshot: ConversationSnapshot = {
        state: previewState,
        rows: reuseTimelineRows(snapshotCache?.rows ?? [], buildTimeline(previewState)),
        demo: true,
        loadingOlder,
        identityKey: identityKey(previewState.identity),
      };
      snapshotCache = snapshot;
      snapshotCachePreview = previewState;
      snapshotCacheLoadingOlder = loadingOlder;
      return snapshot;
    }
    const reason = unavailableReason(input);
    if (reason !== undefined) {
      const state = resetConversation(0, input.identity, "unavailable", reason);
      return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
    }
    const client = input.client;
    if (client === null) {
      const state = resetConversation(0, input.identity, "unavailable", "当前 Client 未提供 transcript hydrate。");
      return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
    }
    const convo = conversationOf(client);
    if (convo === undefined) {
      const state = resetConversation(0, input.identity, "unavailable", "当前 Client 未提供 transcript hydrate。");
      return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
    }
    if (
      snapshotCache !== null &&
      snapshotCacheConvo === convo &&
      snapshotCachePending === pendingUsers &&
      snapshotCacheDisplays === userDisplays &&
      snapshotCacheThumbs === userThumbs &&
      snapshotCacheLoadingOlder === loadingOlder
    ) {
      return snapshotCache;
    }
    const absorbed = absorbPendingDisplays(pendingUsers, persistedItemsOf(convo), userDisplays);
    const thumbs = mergeThumbMaps(userThumbs, thumbsFromDisplays(absorbed.displays));
    const hydrate = selectConversationHydrate(convo);
    const hydrateStatus: HydrateStatus =
      convo.resyncRequired && hydrate.status !== "error" ? "resyncing" : hydrate.status;
    const state = projectClientConversation(convo, absorbed.pending, {
      identityFallback: input.identity,
      hydrateStatus,
      userDisplays: absorbed.displays,
      userThumbs: thumbs,
      ...(hydrate.error === undefined ? {} : { error: hydrate.error }),
    });
    const snapshot: ConversationSnapshot = {
      state,
      rows: reuseTimelineRows(
        snapshotCache?.rows ?? reuseBaseline,
        rowsProjector.project(selectConversationViews(convo), absorbed.pending, convo.itemErrors, absorbed.displays, thumbs),
      ),
      demo: false,
      loadingOlder,
      identityKey: identityKey(state.identity),
    };
    snapshotCache = snapshot;
    snapshotCacheConvo = convo;
    snapshotCachePending = pendingUsers;
    snapshotCacheDisplays = userDisplays;
    snapshotCacheThumbs = userThumbs;
    snapshotCacheLoadingOlder = loadingOlder;
    return snapshot;
  };

  return {
    getSnapshot() {
      try {
        return readSnapshot();
      } catch (cause) {
        const state = {
          ...resetConversation(0, input.identity, "error"),
          error: asClientError(cause),
        };
        return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      hydrateInFlight = false;
      pendingUsers = [];
      userDisplays = {};
      userThumbs = {};
      snapshotCache = null;
      snapshotCacheConvo = undefined;
      snapshotCachePreview = null;
      unsubEvent?.();
      unsubState?.();
      unsubEvent = undefined;
      unsubState = undefined;
      if (input.preview) {
        setPreviewState({
          ...resetConversation(1, input.identity, "ready"),
          items: input.previewItems.slice(),
          hasMoreBefore: false,
        });
        if (input.previewLive && input.identity) {
          let next = previewState;
          for (const event of input.previewLive) {
            next = applyLiveEvent(next, event, input.identity);
          }
          setPreviewState(next);
        }
        return;
      }
      const reason = unavailableReason(input);
      if (reason !== undefined) {
        emit();
        return;
      }
      if (input.client === null || input.identity === null) return;
      unsubEvent = input.client.subscribe({ scope: "runtime" }, onRuntimeEvent);
      unsubState = input.client.onState(onClientState);
      const sessionId = input.identity.sessionId;
      thumbsLoaded = thumbStore.load(sessionId).then((loaded) => {
        if (disposed) return;
        userThumbs = mergeThumbMaps(loaded, userThumbs);
        emit();
      }).catch(() => {});
      void readLatest();
    },
    dispose() {
      disposed = true;
      hydrateInFlight = false;
      releaseHydrateWaiters();
      unsubEvent?.();
      unsubState?.();
      unsubEvent = undefined;
      unsubState = undefined;
      snapshotCache = null;
      listeners.clear();
    },
    async reload() {
      if (input.preview || disposed) return;
      await waitHydrateIdle();
      if (disposed) return;
      await readLatest();
    },
    restoreFromUser(itemId) {
      if (!input.preview) return false;
      const index = previewState.items.findIndex((item) => item.itemId === itemId);
      if (index < 0) return false;
      setPreviewState({
        ...previewState,
        items: previewState.items.slice(0, index),
        liveMessages: {},
        liveTools: {},
        liveOrder: [],
        pendingUsers: [],
        openTurnItems: {},
      });
      return true;
    },
    async loadOlder() {
      if (input.preview || loadingOlder || disposed) return;
      if (input.client === null || input.identity === null) return;
      const convo = conversationOf(input.client);
      if (convo === undefined || !convo.hasMoreBefore || convo.olderCursor === undefined) return;
      const generation = convo.hydrateGeneration;
      const cursor: OpaqueCursor = convo.olderCursor;
      const currentItems = persistedItemsOf(convo);
      let currentBytes = 0;
      for (const item of currentItems) currentBytes += utf8ByteLength(JSON.stringify(item));
      const budget = {
        maxItems: Math.max(0, CONVERSATION_WINDOW_ITEM_LIMIT - currentItems.length),
        maxBytes: Math.max(0, CONVERSATION_WINDOW_BYTE_LIMIT - currentBytes),
      };
      loadingOlder = true;
      emit();
      try {
        if (input.identity.runtimeEpoch === undefined && input.client.prependArchiveTranscript !== undefined) {
          const page = await readArchiveWindow(cursor, budget);
          if (disposed) return;
          input.client.prependArchiveTranscript(page, generation);
        } else {
          const page = await readLiveWindow(cursor, budget);
          if (disposed) return;
          input.client.prependTranscript(page, generation);
        }
      } catch (cause) {
        if (disposed) return;
        const error = conversationWindowClientError(cause) ?? asClientError(cause);
        if (isStaleCursorError(error)) {
          void readLatest();
          return;
        }
        input.client.failTranscriptHydrate(error, generation);
      } finally {
        loadingOlder = false;
        emit();
      }
    },
    trackPending(pending) {
      if (input.preview) {
        setPreviewState(trackPending(previewState, pending));
        return;
      }
      pendingUsers = trackPending({ ...emptyConversationState(), pendingUsers }, pending).pendingUsers;
      emit();
    },
    failPending(requestId, error) {
      if (input.preview) {
        setPreviewState(failPending(previewState, requestId, error));
        return;
      }
      pendingUsers = failPending({ ...emptyConversationState(), pendingUsers }, requestId, error).pendingUsers;
      emit();
    },
    dropPending(requestId) {
      if (input.preview) {
        setPreviewState(dropPending(previewState, requestId));
        return;
      }
      pendingUsers = dropPending({ ...emptyConversationState(), pendingUsers }, requestId).pendingUsers;
      emit();
    },
  };
}
