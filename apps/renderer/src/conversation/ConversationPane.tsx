import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { ActivityLine } from "./ActivityLine";
import { ConvoTranscript } from "./ConvoTranscript";
import { ConversationSkeleton } from "./ConversationSkeleton";
import { ConversationMinimap } from "./ConversationMinimap";
import {
  IDLE_CONVERSATION_SWITCH,
  nextConversationSwitch,
  SWITCH_SETTLE_FRAMES,
  switchPhaseMs,
  switchVeilLeaving,
  type ConversationSwitchPhase,
} from "./conversationSwitchPhase";
import { conversationFollowKey, useConversationScroll } from "./useConversationScroll";
import { retainConversationWhileRemounting } from "./useConversation";
import type { ConversationEngine, ConversationSnapshot } from "./conversationEngine";
import { resetConversation, tailStreaming, type ConversationState, type TimelineRow, withCompactingRow } from "./conversationViewModel";
import { isRetryTranscriptNotice } from "./activityStatus";
import { isTransientStatusNotice } from "./transientStatusNotice";
import type { SubagentHubTarget } from "./toolMeta";
import { PlanCreatedCard, type PlanCreatedLink } from "../deck/PlanCreatedCard";

const FALLBACK_SNAPSHOT: ConversationSnapshot = {
  state: resetConversation(0, null, "unavailable", "当前没有活动会话。"),
  rows: [],
  demo: false,
  loadingOlder: false,
  identityKey: "",
};
const EMPTY_SNAPSHOT = (): ConversationSnapshot => FALLBACK_SNAPSHOT;
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;

/** 上一屏已经画出来的正文，连同它当时的滚动编排输入。
 *  `node` 存的是 ReactNode 引用本身：切换会话的空窗期把同一个元素对象再交给
 *  React，它按引用相等直接跳过整棵子树，DOM（含虚拟列表状态与滚动位置）原样留在
 *  屏上淡出，代价为零。 */
type PaintedBody = {
  readonly node: ReactNode;
  readonly itemCount: number;
  readonly contentKey: string;
  readonly rows: readonly TimelineRow[];
  /** 画的是欢迎面（而非 transcript）；identity 在欢迎面之间变化时无需过场。 */
  readonly welcome: boolean;
  /** 画这一屏时滚动编排用的输入；leaving 期间照它冻结，旧屏停在当前滚动位置淡出。 */
  readonly identityKey: string;
  readonly pin: "top" | "bottom";
};

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ConversationPane({
  snapshot,
  liveEngine,
  onLoadOlder,
  onRestore,
  onRestoreUserMessage,
  onBranchUserMessage,
  userRestoreDisabledReason,
  userBranchDisabledReason,
  onReviewChanges,
  onInspectSubagent,
  liveAgents,
  scrollerRef: externalScrollerRef,
  standby,
  activity,
  welcome,
  forceWelcome,
  onSurfaceWelcomeChange,
  planLink,
  compacting,
  jumpToLatestSlot,
  onRetryTurn,
  retryTurnDisabledReason,
}: {
  snapshot?: ConversationSnapshot;
  /** Hot token/tool stream. Kept here so animation-frame updates do not
   * re-render the surrounding workbench and composer. */
  liveEngine?: Pick<ConversationEngine, "subscribe" | "getSnapshot">;
  onLoadOlder: () => void;
  onRestore?: (requestId: string) => void;
  onRestoreUserMessage?: (itemId: string, text: string) => void;
  onBranchUserMessage?: (itemId: string, text: string) => void;
  userRestoreDisabledReason?: string;
  userBranchDisabledReason?: string;
  onReviewChanges?: (turnId: string) => void;
  onInspectSubagent?: (target: SubagentHubTarget) => void;
  liveAgents?: readonly StudioAgentSnapshot[];
  /** 由父级（WorkbenchCanvas）传入时，minimap 等兄弟组件共享同一 scroller。 */
  scrollerRef?: RefObject<HTMLElement | null>;
  /** 后台创建新会话等场景：显示占位说明，不渲染旧 transcript 与通知。 */
  standby?: { readonly title: string; readonly detail: string };
  /** 运行中的活动状态；由父级派生，空闲时不传。 */
  activity?: ComponentProps<typeof ActivityLine>;
  /** 新对话 / 空 transcript 欢迎区；传入后不再走诚实空壳。 */
  welcome?: ReactNode;
  /** 后台新建会话时强制欢迎区，避免旧 transcript 在替换前闪一下。 */
  forceWelcome?: boolean;
  /** 实际在屏的面是否为欢迎区（leaving 期间是正在淡出的那一屏）。壳层布局类
   *  （.convo-wrap.is-empty）跟它走而不是跟目标态走，minimap / 居中样式才不会
   *  在旧屏还挂在屏上时把它挤变形。 */
  onSurfaceWelcomeChange?: (welcome: boolean) => void;
  /** 计划评审入口卡；点开 Composer 上方那套 Plan Review 弹窗。 */
  planLink?: PlanCreatedLink;
  /** Live snapshot / user-triggered compact: show the in-progress divider. */
  compacting?: boolean;
  /** 「回到最新」按钮外发给宿主（默认在对话流内 sticky 展示）。 */
  jumpToLatestSlot?: (slot: { readonly visible: boolean; readonly jumpToLatest: () => void }) => void;
  /** 链尾失败/中止轮的「重试上一轮」；预览模式不传即不渲染。 */
  onRetryTurn?: () => void;
  retryTurnDisabledReason?: string;
}) {
  const localScrollerRef = useRef<HTMLElement | null>(null);
  const scrollerRef = externalScrollerRef ?? localScrollerRef;
  const liveSnapshot = useSyncExternalStore(
    liveEngine?.subscribe ?? NOOP_SUBSCRIBE,
    liveEngine?.getSnapshot ?? EMPTY_SNAPSHOT,
    liveEngine?.getSnapshot ?? EMPTY_SNAPSHOT,
  );
  // The live engine is rebuilt whenever the conversation identity changes
  // (transcript revision, runtime epoch, client swap), and its first snapshot is
  // empty. Reading it unconditionally re-blanks the transcript on every remount
  // of the *same* session, which is exactly what `snapshot` — the retained
  // metadata view from `useConversation` — exists to prevent. The retain only
  // applies while the identities agree, so switching sessions still clears.
  const effectiveSnapshot =
    liveEngine === undefined
      ? snapshot
      : retainConversationWhileRemounting(liveSnapshot, snapshot, liveSnapshot.state.identity?.sessionId);
  const { state, rows, demo, loadingOlder, identityKey } = effectiveSnapshot?.state
    ? effectiveSnapshot
    : {
        state: resetConversation(0, null, "unavailable", "当前没有活动会话。"),
        rows: [] as ConversationSnapshot["rows"],
        demo: false,
        loadingOlder: false,
        identityKey: "",
      };
  const showWelcome = Boolean(welcome && (forceWelcome || rows.length === 0) && compacting !== true);
  const displayRows = withCompactingRow(rows, compacting === true, effectiveSnapshot?.state.compacting?.action);
  /**
   * 这一帧有没有属于「当前会话」的东西可画。
   *
   * 切换会话时 engine 按新 identity 重建，第一份快照必然是零行的 `idle/loading`，
   * 真实内容要等 IPC 读完。那一刻画什么都是硬切——之前画的是居中的"正在准备对话"
   * 占位，于是一次切换闪两次版式。宁可先不画，交给下面的过场机接管。
   */
  const pending =
    standby === undefined &&
    !showWelcome &&
    displayRows.length === 0 &&
    (state.hydrateStatus === "idle" || state.hydrateStatus === "loading");
  const paintable = !pending;
  /** 过场只认会话本身：transcript revision / runtime epoch 变化（回溯、分支、重连）
   *  同样会重建 engine，但内容照旧，跟着走过场只会白闪一下。 */
  const switchKey = state.identity?.sessionId ?? (demo ? "demo" : "");
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const painted = useRef<PaintedBody | null>(null);
  const [switchState, dispatchSwitch] = useReducer(nextConversationSwitch, IDLE_CONVERSATION_SWITCH);
  const canFade = painted.current !== null && !reducedMotion;
  // 派生自 props 的状态：在 render 内 dispatch（React 官方许可的模式），让新阶段与
  // 新快照落进同一次提交——否则总有一帧画着「上一阶段该画的东西」，那一帧就是硬切。
  if (switchKey !== switchState.key) {
    // 欢迎面 → 欢迎面（新建会话回执把 identity 从 null 换成新会话）：屏上的面没变，
    // 走 identity 过场会把同一块欢迎页淡出再淡入，看起来就是闪一下重载。
    if (showWelcome && painted.current?.welcome === true) {
      dispatchSwitch({ type: "adopt", key: switchKey });
    } else {
      dispatchSwitch({ type: "identity", key: switchKey, paintable, canFade });
    }
  } else if (pending && (switchState.phase === "idle" || switchState.phase === "revealing")) {
    dispatchSwitch({ type: "pending", canFade });
  } else if (switchState.phase === "waiting" && paintable) {
    dispatchSwitch({ type: "paintable" });
  }
  const liveItemCount = displayRows.length + (activity === undefined ? 0 : 1);
  const liveContentKey = conversationFollowKey(state);
  /**
   * 这一屏是否正在流式产出。
   *
   * 挂在 scroller 上，供非动画用途消费：小地图据此降低测量频率。工具卡的收起/展开
   * 过渡不再按它区分——流式期间已完成的卡片正文已冻结，走完整 0fr→1fr 过渡与静止
   * 态同价；仍逐帧变化的运行中卡片由 BatchChain 自己判 `tool.status` 保持瞬时切换。
   */
  const streaming = tailStreaming(displayRows);
  /** 淡出期间滚动编排看的是「还在屏上那一屏」，否则它会按新会话的空内容重排，
   *  把正在淡出的旧 transcript 抽走高度。 */
  const held = switchState.phase === "leaving" ? painted.current : null;
  /* 在屏的面：leaving 期间是正在淡出的旧屏（可能是欢迎区），之后是目标面。
     壳层据此切 .convo-wrap.is-empty——跟目标态走会让 minimap 在旧屏还挂在屏上
     时就占宽，把它向左顶出一次可见跳变。 */
  const surfaceWelcome = switchState.phase === "leaving" ? painted.current?.welcome === true : showWelcome;
  useEffect(() => { onSurfaceWelcomeChange?.(surfaceWelcome); }, [onSurfaceWelcomeChange, surfaceWelcome]);
  const livePin = showWelcome ? "top" as const : "bottom" as const;
  const scroll = useConversationScroll({
    scrollerRef,
    // identityKey / pin 在 leaving 期间随旧屏冻结：此刻滚动编排若按新 pin 归位，
    // stickToTail 会把还在屏上的旧欢迎页拖到底部。冻结在 leaving 结束的同一提交里
    // 解开（早于 settling / 淡入），新 transcript 的 pinned 复位仍然先于可见帧。
    identityKey: held?.identityKey ?? identityKey,
    itemCount: held?.itemCount ?? liveItemCount,
    loadingOlder,
    pin: held?.pin ?? livePin,
    contentKey: held?.contentKey ?? liveContentKey,
  });
  const prevLoading = useRef(loadingOlder);
  const paintableRef = useRef(paintable);
  paintableRef.current = paintable;

  // 阶段计时。`waiting` 没有时限——这是同一套过场能同时适配"归档会话瞬读完"和
  // "冷 Runtime 开半天"的原因。leaving 期间又切一次会话不会重置 seq，所以这里的
  // 定时器继续跑，旧 transcript 不会因为反复点侧边栏而迟迟淡不完。
  useEffect(() => {
    const ms = switchPhaseMs(switchState.phase, reducedMotion);
    if (ms === null) return;
    const seq = switchState.seq;
    const timer = window.setTimeout(() => dispatchSwitch({ type: "elapsed", seq, paintable: paintableRef.current }), ms);
    return () => window.clearTimeout(timer);
  }, [reducedMotion, switchState.phase, switchState.seq]);

  /* 新 transcript 先隐身挂载两帧：第一帧让虚拟列表量真实行高，第二帧让统一的
     `.convo-doc` ResizeObserver 把 scroller 贴到底。两者完成后才淡入，用户不会看到
     初始估高 → 真实高度 → scrollTop 修正造成的一两次整屏跳动。 */
  useEffect(() => {
    if (switchState.phase !== "settling") return;
    const seq = switchState.seq;
    if (typeof requestAnimationFrame !== "function") {
      dispatchSwitch({ type: "settled", seq });
      return;
    }
    let frameId: number | null = null;
    let remaining = SWITCH_SETTLE_FRAMES;
    const next = () => {
      remaining -= 1;
      if (remaining <= 0) {
        frameId = null;
        dispatchSwitch({ type: "settled", seq });
        return;
      }
      frameId = requestAnimationFrame(next);
    };
    frameId = requestAnimationFrame(next);
    return () => { if (frameId !== null) cancelAnimationFrame(frameId); };
  }, [switchState.phase, switchState.seq]);

  useEffect(() => {
    if (!prevLoading.current && loadingOlder) scroll.preparePrepend();
    prevLoading.current = loadingOlder;
  }, [loadingOlder, scroll]);

  /* Capture the anchor in the click itself: the earliest point that is still
     guaranteed to be before the prepended page reaches the DOM. */
  function loadOlder(): void {
    scroll.preparePrepend();
    onLoadOlder();
  }

  const liveBody: ReactNode = standby ? (
    <div className="empty" style={{ paddingTop: 72 }}>
      <span className="spinner" aria-hidden="true" />
      <p>{standby.title}</p>
      <p className="muted small">{standby.detail}</p>
    </div>
  ) : showWelcome ? (
    <>
      {welcome}
      {activity === undefined ? null : <ActivityLine {...activity} />}
    </>
  ) : (
    <>
      {demo ? null : <StatusBanner state={state} />}
      {state.hasMoreBefore && state.hydrateStatus === "ready" ? (
        <div className="convo-load-earlier">
          <button
            type="button"
            className="btn small outline"
            disabled={loadingOlder}
            onClick={loadOlder}
          >
            {loadingOlder ? "正在加载更早消息…" : "加载更早消息"}
          </button>
        </div>
      ) : null}
      {state.notices.map((notice) => {
        if (isTransientStatusNotice(notice.message, notice.source)) return null;
        if (isRetryTranscriptNotice(notice.message, notice.source)) return null;
        const xdevGroups = parseXdevMountNotice(notice.message);
        if (xdevGroups !== null) {
          return <XdevMountNotice key={notice.id} level={notice.level} groups={xdevGroups} />;
        }
        return (
          <div key={notice.id} className={`convo-notice ${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
            {notice.message}
          </div>
        );
      })}
      {displayRows.length === 0 ? (
        <>
          {welcome ?? <EmptyConversation state={state} demo={demo} />}
          {planLink === undefined || planLink.attachEvenWithoutPropose !== true ? null : (
            <PlanCreatedCard
              title={planLink.title ?? "Plan"}
              onOpen={planLink.onOpen}
              {...(planLink.demo === true || demo === true ? { demo: true } : {})}
            />
          )}
        </>
      ) : (
        <ConvoTranscript
          scrollerRef={scrollerRef}
          rows={displayRows}
          demo={demo}
          {...(onRestore === undefined ? {} : { onRestore })}
          {...(onRestoreUserMessage === undefined ? {} : { onRestoreUserMessage })}
          {...(onBranchUserMessage === undefined ? {} : { onBranchUserMessage })}
          {...(userRestoreDisabledReason === undefined ? {} : { userRestoreDisabledReason })}
          {...(userBranchDisabledReason === undefined ? {} : { userBranchDisabledReason })}
          {...(onReviewChanges === undefined ? {} : { onReviewChanges })}
          {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
          {...(liveAgents === undefined ? {} : { liveAgents })}
          {...(planLink === undefined ? {} : { planLink })}
          {...(onRetryTurn === undefined ? {} : { onRetryTurn })}
          {...(retryTurnDisabledReason === undefined ? {} : { retryTurnDisabledReason })}
        />
      )}
      {state.hydrateStatus === "resyncing" ? (
        <div className="convo-notice info" role="status">正在同步</div>
      ) : null}
      {activity === undefined ? null : <ActivityLine {...activity} />}
    </>
  );
  // leaving 期间即使新会话已经读到，也必须继续画进入过场前捕获的旧节点；此前这里会在
  // 140ms 淡出中途把 DOM 换成新 transcript，正是切换时第一次整屏跳动的来源。
  const heldBody = switchState.phase === "leaving" ? painted.current : null;
  // key 变化的那趟 render 末尾会排队 identity/adopt dispatch，React 随即丢弃该趟 JSX
  // 重渲——但 ref 写入不会回滚。不在这里拦下，「永远可画」的欢迎页会在 leaving 开始
  // 前就把 painted 换成自己，旧 transcript 再也留不住，切换时整块硬切加一次淡出淡入。
  const keysChanging = switchKey !== switchState.key;
  if (paintable && switchState.phase !== "leaving" && !keysChanging) {
    painted.current = { node: liveBody, itemCount: liveItemCount, contentKey: liveContentKey, rows: displayRows, welcome: showWelcome, identityKey, pin: livePin };
  }
  const body = switchState.phase === "leaving" ? heldBody?.node ?? null : paintable ? liveBody : null;
  const minimapRows = standby !== undefined || showWelcome
    ? []
    : switchState.phase === "leaving"
      ? heldBody?.rows ?? []
      : paintable
        ? displayRows
        : [];
  const visualStreaming = switchState.phase === "leaving"
    ? tailStreaming(heldBody?.rows ?? [])
    : streaming;

  useEffect(() => {
    jumpToLatestSlot?.({ visible: scroll.hasNewContent, jumpToLatest: scroll.jumpToLatest });
  }, [jumpToLatestSlot, scroll.hasNewContent, scroll.jumpToLatest]);

  return (
    <>
      <main
        className="convo-scroll"
        id="convoScroll"
        ref={scrollerRef}
        tabIndex={-1}
        aria-label="对话内容"
        {...(visualStreaming ? { "data-live-stream": "1" } : {})}
        onScroll={scroll.onScroll}
      >
        <div
          className="convo-doc"
          id="convoDoc"
          role="log"
          aria-live="off"
          aria-relevant="additions"
          {...(switchState.phase === "waiting" || switchState.phase === "settling" ? { "aria-busy": true } : {})}
        >
          {switchState.veil ? <ConversationSkeleton {...(switchVeilLeaving(switchState) ? { leaving: true } : {})} /> : null}
          <div className="convo-body" data-phase={switchState.phase}>{body}</div>
        </div>
        <div className="sr-only" aria-live="polite">
          {latestAnnouncement(state, displayRows.length, switchState.phase)}
        </div>
      </main>
      <ConversationMinimap
        rows={minimapRows}
        scrollerRef={scrollerRef}
        preview={demo}
        busy={visualStreaming}
        onNavigateStart={scroll.detachFromLatest}
        onJumpToLatest={scroll.jumpToLatest}
      />
    </>
  );
}

/** Runtime 的 `xd://` 设备挂载通知（`xd://: mounted …; unmounted …`）。
 * MCP 工具全量挂载时名单极长，只保留一行标题并默认折叠。 */
type XdevMountGroups = {
  readonly mounted?: readonly string[];
  readonly unmounted?: readonly string[];
};

export function parseXdevMountNotice(message: string): XdevMountGroups | null {
  const match = /^xd:\/\/:\s*([\s\S]+)$/.exec(message);
  if (match === null) return null;
  const groups: { mounted?: string[]; unmounted?: string[] } = {};
  let matched = false;
  for (const segment of match[1]!.split(";")) {
    const verb = /^(mounted|unmounted)\s+([\s\S]+)$/.exec(segment.trim());
    if (verb === null) continue;
    matched = true;
    const key = verb[1] === "mounted" ? "mounted" : "unmounted";
    const names = verb[2]!.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
    groups[key] = [...(groups[key] ?? []), ...names];
  }
  return matched ? groups : null;
}

function xdevMountTitle(groups: XdevMountGroups): string {
  const mounted = groups.mounted?.length ?? 0;
  const unmounted = groups.unmounted?.length ?? 0;
  if (mounted > 0 && unmounted > 0) return `xd:// 设备变更 · 挂载 ${mounted} · 卸载 ${unmounted}`;
  if (mounted > 0) return `xd:// 设备已挂载 · ${mounted} 个工具`;
  return `xd:// 设备已卸载 · ${unmounted} 个工具`;
}

function XdevMountGroup({ label, names }: { label: string; names: readonly string[] }) {
  return (
    <div className="xdev-mount-group">
      <p className="xdev-mount-group-label">{label} {names.length}</p>
      {names.map((name) => (
        <div key={name} className="xdev-mount-name mono">{name}</div>
      ))}
    </div>
  );
}

function XdevMountNotice({ level, groups }: { level: string; groups: XdevMountGroups }) {
  const [open, setOpen] = useState(false);
  const title = xdevMountTitle(groups);
  return (
    <div className={`convo-notice ${level} xdev-mount${open ? " open" : ""}`}>
      <button
        type="button"
        className="xdev-mount-toggle"
        aria-expanded={open}
        aria-label={`${title}，${open ? "收起" : "展开"}名单`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="plug" extra="sm" />
        <span className="xdev-mount-title">{title}</span>
        <Icon name="chevron-d" extra="sm tl-chev" />
      </button>
      <div className="xdev-mount-body">
        <div className="xdev-mount-motion">
          <div className="xdev-mount-scroll">
            {groups.mounted === undefined ? null : <XdevMountGroup label="已挂载" names={groups.mounted} />}
            {groups.unmounted === undefined ? null : <XdevMountGroup label="已卸载" names={groups.unmounted} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ state }: { state: ConversationState }) {
  // 加载态不在这里出声：切换会话的空窗由骨架屏（.convo-veil）兜住，
  // 再加一条"正在加载对话"横幅等于把同一件事说两遍，且横幅会撑高文档。
  if (state.hydrateStatus === "error" && state.error) {
    return (
      <div className="convo-notice error" role="alert">
        加载失败：{state.error.message}
      </div>
    );
  }
  return null;
}

function EmptyConversation({ state, demo }: { state: ConversationState; demo: boolean }) {
  if (demo) return null;
  if (state.hydrateStatus === "unavailable") {
    return (
      <div className="empty" style={{ paddingTop: 72 }}>
        <Icon name="message" extra="lg" />
        <p>对话不可用</p>
        <p className="muted small">{state.unavailableReason ?? "当前 Runtime 无法提供 transcript。"}</p>
      </div>
    );
  }
  if (state.hydrateStatus === "error") {
    return (
      <div className="empty" style={{ paddingTop: 72 }}>
        <Icon name="alert" extra="lg" />
        <p>无法加载对话</p>
        <p className="muted small">{state.error?.message ?? "读取 transcript 失败。"}</p>
      </div>
    );
  }
  if (state.hydrateStatus === "loading" || state.hydrateStatus === "idle") {
    // 空窗期由骨架屏接管；这里再画一个"正在准备对话"占位就是之前那次硬切。
    return null;
  }
  return (
    <div className="empty" style={{ paddingTop: 72 }}>
      <Icon name="message" extra="lg" />
      <p>开始一段对话</p>
      <p className="muted small">向当前会话发送消息后，真实 transcript 会显示在这里。</p>
    </div>
  );
}

function latestAnnouncement(state: ConversationState, rowCount: number, phase: ConversationSwitchPhase): string {
  if (phase === "waiting" || phase === "settling") return "正在加载对话";
  if (state.hydrateStatus === "unavailable") return state.unavailableReason ?? "";
  if (state.hydrateStatus === "error") return state.error?.message ?? "";
  const last = Object.values(state.liveMessages).at(-1);
  if (last?.aborted) return "回复已中止";
  if (rowCount > 0 && state.hydrateStatus === "ready" && Object.keys(state.liveMessages).length === 0) {
    return "";
  }
  return "";
}
