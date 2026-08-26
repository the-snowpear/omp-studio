import { useEffect, useId, useRef } from "react";
import type { SessionId } from "@omp-studio/client-contract";
import { ChipComposer } from "../composer/ChipComposer";
import type { MentionCandidate } from "../composer/types";
import { Icon } from "../icons";
import { MessageQueueBar } from "../MessageQueueBar";
import { ConvoTranscript } from "./ConvoTranscript";
import {
  findSubagentComposerAgent,
  subagentComposerVisible,
  subagentTurnRunning,
  type SubagentComposerAgent,
} from "./subagentComposerGate";
import { useSubagentComposer, type SubagentComposerClient } from "./useSubagentComposer";
import { conversationFollowKey, useConversationScroll } from "./useConversationScroll";
import { useSubagentConversation } from "./useSubagentConversation";
import type { SubagentConversationClient } from "./subagentConversationEngine";
import type { SubagentHubTarget } from "./toolMeta";

function queuePlaceholder(editing: boolean, running: boolean): string {
  if (editing) return "正在编辑排队消息…";
  if (running) return "子 Agent 进行中，Enter 排队…";
  return "发给子 Agent… @ 引用文件、Agent 或 Skill";
}

export function SubagentConversationPane({
  target,
  preview,
  client,
  sendClient,
  agents,
  canSend,
  runtimeConnected,
  parentSessionId,
  liveSessionId,
  pendingInteraction,
  workspaceId,
  loadMentions,
  composerId,
  autoFocusComposer,
  previewComposer,
}: {
  readonly target: SubagentHubTarget;
  readonly preview: boolean;
  readonly client: SubagentConversationClient | null;
  readonly sendClient: SubagentComposerClient | null;
  readonly agents: readonly SubagentComposerAgent[];
  readonly canSend: boolean;
  readonly runtimeConnected: boolean;
  readonly parentSessionId?: SessionId;
  readonly liveSessionId?: SessionId;
  readonly pendingInteraction?: boolean;
  readonly workspaceId?: string;
  readonly loadMentions?: (trigger: "@" | "/", query: string) => Promise<readonly MentionCandidate[]>;
  readonly composerId?: string;
  readonly autoFocusComposer?: boolean;
  readonly previewComposer?: boolean;
}) {
  const generatedId = useId();
  const composerDomId = composerId ?? `subagentComposer${generatedId}`;
  const hintId = `${composerDomId}Hint`;
  const scrollerRef = useRef<HTMLElement | null>(null);
  const snapshot = useSubagentConversation({
    preview,
    client,
    target,
    runtimeConnected,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(liveSessionId === undefined ? {} : { liveSessionId }),
  });
  const agent = findSubagentComposerAgent(agents, target.agentId);
  const composerAllowed = subagentComposerVisible({
    preview,
    runtimeConnected,
    hasClient: sendClient !== null,
    canSend,
    agent,
    ...(previewComposer === undefined ? {} : { previewComposer }),
  });
  const running = subagentTurnRunning(snapshot.state);
  const composer = useSubagentComposer({
    enabled: composerAllowed,
    running,
    ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
    client: sendClient,
    agent,
    sessionId: snapshot.state.identity?.sessionId,
    ...(preview ? { preview: true } : {}),
  });
  const scroll = useConversationScroll({
    scrollerRef,
    identityKey: snapshot.identityKey,
    itemCount: snapshot.rows.length,
    loadingOlder: snapshot.loadingOlder,
    contentKey: conversationFollowKey(snapshot.state),
  });
  const prevLoading = useRef(snapshot.loadingOlder);
  useEffect(() => {
    if (!prevLoading.current && snapshot.loadingOlder) scroll.preparePrepend();
    prevLoading.current = snapshot.loadingOlder;
  }, [snapshot.loadingOlder, scroll]);

  /* Anchor on the click, before the prepended page can reach the DOM. */
  function loadOlder(): void {
    scroll.preparePrepend();
    snapshot.loadOlder();
  }

  useEffect(() => {
    if (autoFocusComposer !== true || !composerAllowed) return;
    composer.composerRef.current?.focus({ preventScroll: true });
  }, [autoFocusComposer, composer.composerRef, composerAllowed, target.agentId, target.toolCallId]);

  const { state } = snapshot;
  return (
    <div className={`subagent-convo${composerAllowed ? " has-composer" : ""}`}>
      <section
        className="sa-inspect-scroll"
        ref={scrollerRef}
        tabIndex={-1}
        aria-label="子 Agent 对话"
        onScroll={scroll.onScroll}
      >
        <div className="sa-inspect-doc" role="log" aria-live="off">
          {state.hydrateStatus === "error" && state.error !== undefined ? (
            <div className="convo-notice error" role="alert">{state.error.message}</div>
          ) : null}
          {state.hydrateStatus === "unavailable" && state.unavailableReason !== undefined ? (
            <div className="empty" style={{ paddingTop: 48 }}>
              <p>{state.unavailableReason}</p>
            </div>
          ) : null}
          {state.hasMoreBefore && state.hydrateStatus === "ready" ? (
            <div className="convo-load-earlier">
              <button type="button" className="btn small outline" disabled={snapshot.loadingOlder} onClick={loadOlder}>
                {snapshot.loadingOlder ? "正在加载更早消息…" : "加载更早消息"}
              </button>
            </div>
          ) : null}
          {snapshot.rows.length === 0 && state.hydrateStatus === "loading" ? (
            <div className="empty" style={{ paddingTop: 48 }}>
              <span className="spinner" aria-hidden="true" />
              <p>正在读取子 Agent 对话…</p>
            </div>
          ) : (
            <ConvoTranscript rows={snapshot.rows} {...(snapshot.demo ? { demo: true } : {})} />
          )}
          {state.hydrateStatus === "resyncing" ? (
            <div className="convo-notice info" role="status">正在同步</div>
          ) : null}
        </div>
      </section>
      {scroll.hasNewContent ? (
        <button
          type="button"
          className="new-content-pill"
          onClick={scroll.jumpToLatest}
          aria-label="回到最新"
          data-tip="回到最新"
        >
          <Icon name="chevron-d" />
        </button>
      ) : null}
      {composerAllowed ? (
        <div className="sa-inspect-composer">
          <MessageQueueBar
            messages={composer.queued}
            running={running}
            sendEnabled={running ? composer.steerEnabled : true}
            {...(composer.queueEdit === undefined ? {} : { editingId: composer.queueEdit.entryId })}
            onEdit={composer.editQueued}
            onSendNow={composer.sendQueuedNow}
            onRemove={composer.removeQueued}
          />
          <label className="sr-only" htmlFor={composerDomId}>发给子 Agent 的消息</label>
          <ChipComposer
            ref={composer.composerRef}
            id={composerDomId}
            placeholder={queuePlaceholder(composer.queueEdit !== undefined, running)}
            describedBy={hintId}
            compact={running}
            {...(workspaceId === undefined ? {} : { workspaceId })}
            {...(loadMentions === undefined ? {} : { loadMentions })}
            onRunCommand={() => composer.rejectSlash()}
            onChange={composer.setDraft}
            onSubmit={composer.submitPrompt}
            onQueue={composer.enqueueDraft}
            onFollowUp={composer.submitFollowUp}
            {...(composer.queueEdit === undefined ? {} : { onEscape: composer.cancelEdit })}
            running={running}
            onError={(message) => composer.setError(message)}
          />
          <div className="composer-bar">
            <div className="cb-group">
              <button
                type="button"
                className="icon-btn small"
                data-tip="附件"
                aria-label="附件 / 图片"
                onClick={() => composer.composerRef.current?.openFilePicker()}
              >
                <Icon name="attach" extra="sm" />
              </button>
            </div>
          </div>
          <p className="sr-only" id={hintId}>{
            composer.queueEdit !== undefined
              ? "正在编辑排队消息。Enter 写回原位，Escape 取消。"
              : running
                ? "按 Enter 将消息加入排队栏，本轮结束后发给子 Agent。Ctrl+Enter 作为后续消息发送。"
                : "按 Enter 发给子 Agent，Ctrl+Enter 作为后续消息发送，Shift+Enter 换行"
          }</p>
          {composer.error ? (
            <div className="composer-error" role="alert">
              <Icon name="alert" extra="sm" />
              <span>{composer.error}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
