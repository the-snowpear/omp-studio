import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { ActivityLine } from "./ActivityLine";
import { ConvoTranscript } from "./ConvoTranscript";
import { conversationFollowKey, useConversationScroll } from "./useConversationScroll";
import type { ConversationSnapshot } from "./conversationEngine";
import { resetConversation, type ConversationState, withCompactingRow } from "./conversationViewModel";
import { isRetryTranscriptNotice } from "./activityStatus";
import { isTransientStatusNotice } from "./transientStatusNotice";
import type { SubagentHubTarget } from "./toolMeta";
import { PlanCreatedCard, type PlanCreatedLink } from "../deck/PlanCreatedCard";

export function ConversationPane({
  snapshot,
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
  planLink,
  compacting,
}: {
  snapshot?: ConversationSnapshot;
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
  /** 计划评审入口卡；点开 Composer 上方那套 Plan Review 弹窗。 */
  planLink?: PlanCreatedLink;
  /** Live snapshot / user-triggered compact: show the in-progress divider. */
  compacting?: boolean;
}) {
  const localScrollerRef = useRef<HTMLElement | null>(null);
  const scrollerRef = externalScrollerRef ?? localScrollerRef;
  const { state, rows, demo, loadingOlder, identityKey } = snapshot?.state
    ? snapshot
    : {
        state: resetConversation(0, null, "unavailable", "当前没有活动会话。"),
        rows: [] as ConversationSnapshot["rows"],
        demo: false,
        loadingOlder: false,
        identityKey: "",
      };
  const showWelcome = Boolean(welcome && (forceWelcome || rows.length === 0) && compacting !== true);
  const displayRows = withCompactingRow(rows, compacting === true, snapshot?.state.compacting?.action);
  const scroll = useConversationScroll({
    scrollerRef,
    identityKey,
    itemCount: displayRows.length + (activity === undefined ? 0 : 1),
    loadingOlder,
    pin: showWelcome ? "top" : "bottom",
    contentKey: conversationFollowKey(state),
  });
  const prevLoading = useRef(loadingOlder);

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

  return (
    <main
      className="convo-scroll"
      id="convoScroll"
      ref={scrollerRef}
      tabIndex={-1}
      aria-label="对话内容"
      onScroll={scroll.onScroll}
    >
      <div className="convo-doc" id="convoDoc" role="log" aria-live="off" aria-relevant="additions">
        {standby ? (
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
              />
            )}
            {state.hydrateStatus === "resyncing" ? (
              <div className="convo-notice info" role="status">正在同步</div>
            ) : null}
            {activity === undefined ? null : <ActivityLine {...activity} />}
          </>
        )}
      </div>
      {scroll.hasNewContent ? (
        <div className="new-content-pill-row">
          <button
            type="button"
            className="new-content-pill"
            onClick={scroll.jumpToLatest}
            aria-label="回到最新"
            data-tip="回到最新"
          >
            <Icon name="chevron-d" />
          </button>
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {latestAnnouncement(state, displayRows.length)}
      </div>
    </main>
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
  if (state.hydrateStatus === "loading") {
    return <div className="convo-notice info" role="status">正在加载对话</div>;
  }
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
    return (
      <div className="empty" style={{ paddingTop: 72 }}>
        <Icon name="message" extra="lg" />
        <p>正在准备对话</p>
      </div>
    );
  }
  return (
    <div className="empty" style={{ paddingTop: 72 }}>
      <Icon name="message" extra="lg" />
      <p>开始一段对话</p>
      <p className="muted small">向当前会话发送消息后，真实 transcript 会显示在这里。</p>
    </div>
  );
}

function latestAnnouncement(state: ConversationState, rowCount: number): string {
  if (state.hydrateStatus === "unavailable") return state.unavailableReason ?? "";
  if (state.hydrateStatus === "error") return state.error?.message ?? "";
  const last = Object.values(state.liveMessages).at(-1);
  if (last?.aborted) return "回复已中止";
  if (rowCount > 0 && state.hydrateStatus === "ready" && Object.keys(state.liveMessages).length === 0) {
    return "";
  }
  return "";
}
