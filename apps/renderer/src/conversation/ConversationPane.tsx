import { useEffect, useRef } from "react";
import { Icon } from "../icons";
import { ConvoTranscript } from "./ConvoTranscript";
import { useConversationScroll } from "./useConversationScroll";
import type { ConversationSnapshot } from "./conversationEngine";
import { resetConversation, type ConversationState } from "./conversationViewModel";

export function ConversationPane({
  snapshot,
  onLoadOlder,
  onRestore,
}: {
  snapshot?: ConversationSnapshot;
  onLoadOlder: () => void;
  onRestore?: (requestId: string) => void;
}) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const { state, rows, demo, loadingOlder, identityKey } = snapshot?.state
    ? snapshot
    : {
        state: resetConversation(0, null, "unavailable", "当前没有活动会话。"),
        rows: [] as ConversationSnapshot["rows"],
        demo: false,
        loadingOlder: false,
        identityKey: "",
      };
  const scroll = useConversationScroll({
    scrollerRef,
    identityKey,
    itemCount: rows.length,
    loadingOlder,
  });
  const prevLoading = useRef(loadingOlder);

  useEffect(() => {
    if (!prevLoading.current && loadingOlder) scroll.preparePrepend();
    prevLoading.current = loadingOlder;
  }, [loadingOlder, scroll]);

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
        {demo ? null : <StatusBanner state={state} />}
        {state.hasMoreBefore && state.hydrateStatus === "ready" ? (
          <div className="convo-load-earlier">
            <button
              type="button"
              className="btn small outline"
              disabled={loadingOlder}
              onClick={onLoadOlder}
            >
              {loadingOlder ? "正在加载更早消息…" : "加载更早消息"}
            </button>
          </div>
        ) : null}
        {state.notices.map((notice) => (
          <div key={notice.id} className={`convo-notice ${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
            {notice.message}
          </div>
        ))}
        {rows.length === 0 ? <EmptyConversation state={state} demo={demo} /> : (
          <ConvoTranscript rows={rows} demo={demo} {...(onRestore === undefined ? {} : { onRestore })} />
        )}
        {state.hydrateStatus === "resyncing" ? (
          <div className="convo-notice info" role="status">正在同步</div>
        ) : null}
      </div>
      {scroll.hasNewContent ? (
        <button type="button" className="new-content-pill" onClick={scroll.jumpToLatest}>
          有新内容 · 回到最新
        </button>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {latestAnnouncement(state, rows.length)}
      </div>
    </main>
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
