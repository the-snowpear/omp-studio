import { useEffect, useMemo, useReducer, useRef } from "react";
import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import { identityKey } from "./conversationHost";
import { createConversationEngine, type ConversationEngine, type ConversationSnapshot } from "./conversationEngine";
import { emptyConversationState, type PendingUser } from "./conversationViewModel";
import { recallSessionRows } from "./sessionRowsCache";
import { recallSessionConversation, rememberSessionConversation } from "./sessionConversationCache";
import { PREVIEW_CONVO_IDENTITY, PREVIEW_CONVO_LIVE, previewConversationItems } from "../preview/conversationFixtures";
import { createConversationCommitGate, type ConversationCommitPriority } from "./conversationCommitGate";

export type UseConversationInput = {
  readonly preview: boolean;
  readonly client: ConversationClient | null;
  readonly identity: ConversationIdentity | null;
  readonly canRead: boolean;
  readonly runtimeConnected: boolean;
  readonly previewThreadId?: string;
  /**
   * 选中的会话正在被激活（`session.resume` 在飞）。Runtime 快照追上以后 identity 会
   * 补上 `runtimeEpoch`，engine 会带着 epoch 重挂一次：此时先别读归档页，否则同一次
   * 切换要读两遍 transcript，而归档那一份马上就被 live 页顶掉。
   */
  readonly activating?: boolean;
};

export type UseConversationResult = ConversationSnapshot & {
  loadOlder: () => void;
  reload: () => Promise<void>;
  restoreFromUser: (itemId: string) => boolean;
  trackPending: (pending: PendingUser) => void;
  failPending: (requestId: string, error: string) => void;
  dropPending: (requestId: string) => void;
};

/**
 * 等 `runtimeEpoch` 的上限。resume 走的是进程内 `selectResident`，正常在几十毫秒内
 * 回执；超过这个窗口就当它不会来，回落到归档读取。
 */
const DEFER_HYDRATE_TIMEOUT_MS = 600;

const emptySnapshot: ConversationSnapshot = {
  state: emptyConversationState(),
  rows: [],
  demo: false,
  loadingOlder: false,
  identityKey: "",
};

/**
 * Keep the last transcript on screen while the engine remounts for the same
 * session (archive → live after resume, or compact completion reload).
 * An empty current snapshot for a *different* session is shown as-is.
 */
export function retainConversationWhileRemounting(
  current: ConversationSnapshot,
  previous: ConversationSnapshot | undefined,
  sessionId: ConversationIdentity["sessionId"] | undefined,
): ConversationSnapshot {
  if (current.rows.length > 0) return current;
  if (sessionId === undefined || previous === undefined || previous.rows.length === 0) return current;
  if (previous.state.identity?.sessionId !== sessionId) return current;
  return previous;
}

function stableCacheRows(rows: readonly ConversationSnapshot["rows"][number][]): ConversationSnapshot["rows"] {
  return rows.filter((row) => {
    if (row.type === "compacting") return false;
    if (row.type === "user") return row.pending === undefined;
    return row.type !== "assistant" || (row.status !== "streaming" && row.turnOpen !== true);
  });
}

function persistentCacheState(state: ConversationSnapshot["state"]): ConversationSnapshot["state"] {
  const {
    error: _error,
    unavailableReason: _unavailableReason,
    compacting: _compacting,
    ...persistent
  } = state;
  return {
    ...persistent,
    liveMessages: {},
    liveTools: {},
    liveOrder: [],
    pendingUsers: [],
    notices: [],
    openTurnItems: {},
    hydrateStatus: "ready",
    resyncRequired: false,
  };
}

/**
 * Engine notifications are decoupled from Runtime event frequency. The shared
 * 45ms gate admits one transcript commit per window; terminal events flush the
 * latest reducer state immediately.
 */
type CoalescedBump = {
  readonly notify: (priority?: ConversationCommitPriority) => void;
  readonly reset: () => void;
};

function useCoalescedBump(): CoalescedBump {
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const coalesced = useMemo<CoalescedBump>(() => {
    const gate = createConversationCommitGate(() => bump());
    return {
      reset: gate.reset,
      notify: gate.notify,
    };
  }, []);

  useEffect(() => coalesced.reset, [coalesced]);
  return coalesced;
}

export function useConversation(input: UseConversationInput): UseConversationResult {
  const { notify, reset } = useCoalescedBump();
  const engineRef = useRef<ConversationEngine | null>(null);
  const heldRef = useRef<ConversationSnapshot | undefined>(undefined);
  const clientRef = useRef(input.client);
  clientRef.current = input.client;
  /* engine 只在 key 变化时重建，激活状态却会在其生命周期内翻转：用 ref 让它读到当前值。 */
  const activatingRef = useRef(input.activating === true);
  activatingRef.current = input.activating === true;
  /* 兜底：epoch 迟迟不来（resume 失败、Runtime 掉线、别的入口选中了驻留会话）就放弃
     等待，照常读归档页——绝不把对话永久停在「正在加载」。 */
  const deferExpiredRef = useRef(false);
  const deferHydrate = useRef(() => activatingRef.current && !deferExpiredRef.current).current;
  // Runtime residency is deliberately not part of the conversation engine
  // identity: a dormant session retains its persistent transcript while its
  // execution worker is offline or recovering.
  const key = `${input.preview}:${input.canRead}:${identityKey(input.identity)}:${input.previewThreadId ?? ""}`;
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    engineRef.current?.dispose();
    engineRef.current = null;
    keyRef.current = key;
  }

  useEffect(() => {
    deferExpiredRef.current = false;
    const engine = createConversationEngine({
      preview: input.preview,
      client: input.preview ? null : clientRef.current,
      identity: input.preview ? PREVIEW_CONVO_IDENTITY : input.identity,
      canRead: input.canRead,
      runtimeConnected: input.runtimeConnected,
      previewItems: previewConversationItems(input.previewThreadId),
      previewLive: PREVIEW_CONVO_LIVE,
      deferHydrate,
      ...(input.preview ? {} : { initialRows: recallSessionRows(input.identity?.sessionId) ?? [] }),
    });
    engineRef.current = engine;
    const off = engine.subscribe(notify);
    engine.start();
    notify();
    return () => {
      off();
      engine.dispose();
      reset();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [key, notify, reset, deferHydrate]);

  /* 等待 epoch 的窗口：到点或激活结束仍没等到 epoch，就把归档页读出来。 */
  const activating = input.activating === true;
  const wasActivatingRef = useRef(activating);
  useEffect(() => {
    if (input.preview) return;
    const was = wasActivatingRef.current;
    wasActivatingRef.current = activating;
    if (activating) {
      const timer = setTimeout(() => {
        deferExpiredRef.current = true;
        void engineRef.current?.reload();
      }, DEFER_HYDRATE_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
    // epoch 到了的话 engine 已经带着 epoch 重挂并读过 live 页，不要再读一遍。
    if (was && input.identity?.runtimeEpoch === undefined) void engineRef.current?.reload();
    return;
  }, [activating, input.preview, input.identity?.runtimeEpoch]);

  let snapshot = emptySnapshot;
  try {
    snapshot = engineRef.current?.getSnapshot() ?? emptySnapshot;
  } catch {
    snapshot = emptySnapshot;
  }
  snapshot = retainConversationWhileRemounting(snapshot, heldRef.current, input.identity?.sessionId);
  const sessionId = input.identity?.sessionId;
  if (snapshot.rows.length > 0) {
    heldRef.current = snapshot;
    if (!input.preview && sessionId !== undefined) {
      const stableRows = stableCacheRows(snapshot.rows);
      if (stableRows.length > 0) rememberSessionConversation(sessionId, stableRows, persistentCacheState(snapshot.state));
    }
  } else if (!input.preview && snapshot.state.hydrateStatus !== "unavailable") {
    /* 新会话的第一页还没落地：先画这条会话上次的行（顶部照常显示「正在加载对话」），
       等真页到达后由 reuseTimelineRows 沿用没变的行。 */
    const cached = recallSessionConversation(sessionId);
    if (cached !== undefined) {
      snapshot = {
        ...snapshot,
        rows: cached.rows,
        ...(cached.state === undefined ? {} : {
          state: {
            ...cached.state,
            generation: snapshot.state.generation,
            identity: snapshot.state.identity,
            hydrateStatus: snapshot.state.hydrateStatus,
          },
        }),
      };
    }
  }
  const actions = useMemo(
    () => ({
      loadOlder: () => {
        void engineRef.current?.loadOlder();
      },
      reload: () => engineRef.current?.reload() ?? Promise.resolve(),
      restoreFromUser: (itemId: string) => engineRef.current?.restoreFromUser(itemId) ?? false,
      trackPending: (pending: PendingUser) => engineRef.current?.trackPending(pending),
      failPending: (requestId: string, error: string) => engineRef.current?.failPending(requestId, error),
      dropPending: (requestId: string) => engineRef.current?.dropPending(requestId),
    }),
    [],
  );
  return { ...snapshot, ...actions };
}
