import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { ConversationMessageError } from "@omp-studio/client-contract";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { PlanCreatedCard, type PlanCreatedLink } from "../deck/PlanCreatedCard";
import { useAppSettings, type ToolActivityDetail } from "../settings/appSettings";
import { useI18n } from "../i18n";
import { BatchChain, type ChainItem } from "./BatchChain";
import { TruncationMark } from "./ToolBody";
import { MarkdownText } from "./markdown";
import { TurnDiffCard } from "./TurnDiffCard";
import { compactRuleLabel, compactSummaryFoldable } from "./compactSummary";
import type { AssistantSegment, TimelineRow } from "./conversationViewModel";
import type { SubagentHubTarget, ThinkView, TurnFileChange } from "./toolMeta";
import { UserMessageBody } from "./UserMessageBody";

function formatTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 元素常量：截断标记没有 props，每次渲染新建只会让 MarkdownText 的 memo 白丢一次。 */
const TRUNCATION_MARK = <TruncationMark />;

const MessageBody = memo(function MessageBody({
  text,
  streaming,
  truncated,
  magicKeywords,
  copyText,
  restore,
  branch,
}: {
  text: string;
  streaming?: boolean;
  truncated?: boolean;
  magicKeywords?: boolean;
  copyText?: string;
  restore?: {
    disabled?: boolean;
    reason?: string;
    onRestore: () => void;
  };
  branch?: {
    disabled?: boolean;
    reason?: string;
    onBranch: () => void;
  };
}) {
  const body = (
    <MarkdownText
      text={text}
      {...(streaming === true ? { streaming: true } : {})}
      {...(truncated === true ? { truncated: true, mark: TRUNCATION_MARK } : {})}
      {...(magicKeywords === true ? { magicKeywords: true } : {})}
    />
  );
  if (restore !== undefined || branch !== undefined) {
    return (
      <div className="ev-copy-host">
        {body}
        <MessageUserActions
          text={copyText ?? ""}
          {...(restore === undefined ? {} : { restore })}
          {...(branch === undefined ? {} : { branch })}
        />
      </div>
    );
  }
  if (copyText === undefined || copyText.length === 0) return body;
  return (
    <div className="ev-copy-host">
      {body}
      <MessageCopyActions text={copyText} />
    </div>
  );
});

function AssistantStatus({ status }: { status: Extract<TimelineRow, { type: "assistant" }>["status"] }) {
  if (status === "aborted") return <span className="chip gray xs">已中止</span>;
  if (status === "error") return <span className="chip red xs">出错</span>;
  return null;
}

function ProviderErrorDetail({ error }: { error: ConversationMessageError }) {
  const meta = [error.status !== undefined ? String(error.status) : undefined, error.provider, error.model]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" · ");
  return (
    <div className="ev-provider-error">
      {meta ? <div className="muted small">{meta}</div> : null}
      <p className="ev-provider-error-text">{error.message}</p>
    </div>
  );
}

function hasAssistantText(segments: readonly AssistantSegment[]): boolean {
  return segments.some((segment) => segment.type === "text" && segment.text.length > 0);
}

function concludingReplyText(segments: readonly AssistantSegment[]): { key: string; text: string } | undefined {
  let last: { key: string; text: string } | undefined;
  for (const segment of segments) {
    if (segment.type === "batch") {
      last = undefined;
      continue;
    }
    if (segment.type === "text" && segment.text.length > 0) last = { key: segment.key, text: segment.text };
  }
  return last;
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      className="ev-msg-copy"
      aria-label={copied ? "已复制" : "复制消息"}
      data-tip={copied ? "已复制" : "复制"}
      onClick={() => {
        const clipboard = typeof navigator === "object" ? navigator.clipboard : undefined;
        if (!clipboard) return;
        clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            if (timerRef.current !== undefined) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      <Icon name={copied ? "check" : "copy"} extra="sm" />
    </button>
  );
}

function MessageCopyActions({ text }: { text: string }) {
  if (text.length === 0) return null;
  return (
    <div className="ev-msg-actions">
      <MessageCopyButton text={text} />
    </div>
  );
}

function MessageUserActions({
  text,
  restore,
  branch,
}: {
  text: string;
  restore?: {
    disabled?: boolean;
    reason?: string;
    onRestore: () => void;
  };
  branch?: {
    disabled?: boolean;
    reason?: string;
    onBranch: () => void;
  };
}) {
  const { t } = useI18n();
  if (text.length === 0 && restore === undefined && branch === undefined) return null;
  return (
    <div className="ev-msg-actions">
      {restore ? (
        <button
          type="button"
          className="ev-msg-copy"
          aria-label={t("conversation.restore")}
          data-tip={restore.disabled === true ? (restore.reason ?? t("conversation.cannotRestore")) : t("conversation.restore")}
          disabled={restore.disabled === true}
          onClick={() => restore.onRestore()}
        >
          <Icon name="undo" extra="sm" />
        </button>
      ) : null}
      {branch ? (
        <button
          type="button"
          className="ev-msg-copy"
          aria-label={t("conversation.branchSession")}
          data-tip={branch.disabled === true ? (branch.reason ?? t("conversation.cannotCreate")) : t("conversation.branchSession")}
          disabled={branch.disabled === true}
          onClick={() => branch.onBranch()}
        >
          <Icon name="branch" extra="sm" />
        </button>
      ) : null}
      {text.length > 0 ? <MessageCopyButton text={text} /> : null}
    </div>
  );
}

function renderAssistantSegments(
  segments: readonly AssistantSegment[],
  options: {
    expandAll?: boolean;
    standalone?: boolean;
    /** 仅 transcript 尾行且仍在流式输出时为 true。 */
    liveTail?: boolean;
    /** 设置 → 对话与交互：显示 Thinking 摘要。 */
    showThinking?: boolean;
    /** 设置 → 常规：工具活动显示（full 展开 / concise 默认 / hidden 隐藏工具链）。 */
    toolActivity?: ToolActivityDetail;
    /** 设置 → 对话与交互：显示工具调用意图。 */
    showToolIntent?: boolean;
    /** 设置 → 常规：流式输出（关闭后不带流式光标渲染）。 */
    showStreaming?: boolean;
    onInspectSubagent?: (target: SubagentHubTarget) => void;
    liveAgents?: readonly StudioAgentSnapshot[];
    allowCopy?: boolean;
  } = {},
): ReactNode[] {
  const showThinking = options.showThinking !== false;
  const showStreaming = options.showStreaming !== false;
  const toolActivity = options.toolActivity ?? "concise";
  const lastText = options.allowCopy === true ? concludingReplyText(segments) : undefined;
  const nodes: ReactNode[] = [];
  let index = 0;
  // React key 用节点在该行里的序号，而不是 segment key：同一段内容在 live → 落盘之间
  // 会换 key（`m1:text:1` → `text-1`、`m1:thinking:0` → `thinking-0`），跟着 segment
  // key 会让正文和整条工具链在落盘那一刻卸载重挂载。
  let bodyCount = 0;
  let chainCount = 0;
  while (index < segments.length) {
    const segment = segments[index]!;
    if (segment.type === "text") {
      nodes.push(
        <MessageBody
          key={`body-${bodyCount}`}
          text={segment.text}
          {...(showStreaming && segment.streaming === true ? { streaming: true } : {})}
          {...(segment.truncated === true ? { truncated: true } : {})}
          {...(lastText?.key === segment.key ? { copyText: lastText.text } : {})}
        />,
      );
      bodyCount += 1;
      index += 1;
      continue;
    }
    // 一条链里的思考与工具保持模型产出顺序：只有中间没被工具打断的连续思考才合成
    // 一张卡，否则工具跑完之后的思考会被并进工具之前的思考里。
    const items: ChainItem[] = [];
    let pendingThink: ThinkView | undefined;
    const flushThink = () => {
      if (pendingThink === undefined) return;
      items.push({ kind: "think", think: pendingThink });
      pendingThink = undefined;
    };
    while (index < segments.length && segments[index]?.type !== "text") {
      const process = segments[index]!;
      if (process.type === "thinking") {
        const text = process.text.trim();
        if (showThinking && text.length > 0) {
          pendingThink =
            pendingThink === undefined
              ? { key: process.key, text, ...(process.truncated === true ? { truncated: true } : {}) }
              : {
                  key: pendingThink.key,
                  text: `${pendingThink.text}\n\n${text}`,
                  ...(pendingThink.truncated === true || process.truncated === true ? { truncated: true } : {}),
                };
        }
      } else if (process.type === "batch" && toolActivity !== "hidden" && process.tools.length > 0) {
        flushThink();
        for (const tool of process.tools) items.push({ kind: "tool", tool });
      }
      index += 1;
    }
    flushThink();
    if (items.length === 0) continue;
    const batchKey = `chain-${chainCount}`;
    chainCount += 1;
    // 该组之后没有别的段落（即 AI 尚未开始输出其后的文本段），且该行是 transcript
    // 尾行、仍在流式输出时，才视为流式尾部链。
    const liveTail = options.liveTail === true && index >= segments.length;
    const chainExpandAll = options.expandAll === true || toolActivity === "full";
    nodes.push(
      <BatchChain
        key={batchKey}
        batchKey={batchKey}
        items={items}
        {...(chainExpandAll ? { expandAll: true } : {})}
        {...(options.standalone === true ? { standalone: true } : {})}
        {...(liveTail ? { liveTail: true } : {})}
        {...(options.showToolIntent === false ? { showDetail: false } : {})}
        {...(options.liveAgents === undefined ? {} : { liveAgents: options.liveAgents })}
        {...(options.onInspectSubagent === undefined ? {} : { onInspectSubagent: options.onInspectSubagent })}
      />,
    );
  }
  return nodes;
}

function TurnChanges({
  files,
  defaultOpen,
  demo,
  onReview,
}: {
  files?: readonly TurnFileChange[];
  defaultOpen?: boolean;
  demo?: boolean;
  onReview?: () => void;
}) {
  if (files === undefined || files.length === 0) return null;
  return (
    <TurnDiffCard
      files={files}
      {...(defaultOpen === true ? { defaultOpen: true } : {})}
      {...(demo === true ? { demo: true } : {})}
      {...(onReview === undefined ? {} : { onReview })}
    />
  );
}

function isCommittedUserRow(row: Extract<TimelineRow, { type: "user" }>): boolean {
  return row.pending === undefined && !row.itemId.startsWith("pending:");
}

function CompactionRule({ item }: { item: Extract<TimelineRow, { type: "compaction" }>["item"] }) {
  const [open, setOpen] = useState(false);
  const label = compactRuleLabel(item);
  const summary = (item.summary.trim() || item.shortSummary?.trim() || "");
  const foldable = compactSummaryFoldable(item);
  const showBody = summary.length > 0 && (foldable ? open : summary !== label);
  return (
    <div className="ev" data-item-id={item.itemId}>
      {foldable ? (
        <button
          type="button"
          className={`compact-rule${open ? " is-open" : ""}`}
          aria-expanded={open}
          aria-label={`Compact · ${label}，${open ? "收起" : "展开"}详情`}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon name="minimize" extra="sm compact-rule-icon" />
          <span className="compact-rule-label"><b>Compact</b> · <span className="compact-rule-text">{label}</span></span>
          <Icon name="chevron-d" extra="sm compact-rule-chev" />
        </button>
      ) : (
        <div className="compact-rule">
          <Icon name="minimize" extra="sm compact-rule-icon" />
          <span className="compact-rule-label"><b>Compact</b> · <span className="compact-rule-text">{label}</span></span>
        </div>
      )}
      {item.warning ? <p className="muted small">{item.warning}</p> : null}
      {showBody ? <div className="compact-summary convo-plain small">{summary}</div> : null}
    </div>
  );
}

export const ConversationItemView = memo(function ConversationItemView({
  row,
  onRestore,
  onRestoreUserMessage,
  onBranchUserMessage,
  userRestoreDisabledReason,
  userBranchDisabledReason,
  expandAll = false,
  fileChanges,
  tail = true,
  changesDefaultOpen,
  demo,
  onReviewChanges,
  onInspectSubagent,
  liveAgents,
  planLink,
}: {
  row: TimelineRow;
  onRestore?: (requestId: string) => void;
  onRestoreUserMessage?: (itemId: string, text: string) => void;
  onBranchUserMessage?: (itemId: string, text: string) => void;
  userRestoreDisabledReason?: string;
  userBranchDisabledReason?: string;
  expandAll?: boolean;
  /** 该行是 transcript 里最后一个 assistant 行；只有它的链尾允许作为流式尾部自动展开/跟随。 */
  tail?: boolean;
  fileChanges?: readonly TurnFileChange[];
  changesDefaultOpen?: boolean;
  demo?: boolean;
  onReviewChanges?: () => void;
  onInspectSubagent?: (target: SubagentHubTarget) => void;
  liveAgents?: readonly StudioAgentSnapshot[];
  planLink?: PlanCreatedLink;
}) {
  const { settings: appSettings } = useAppSettings();
  if (row.type === "user") {
    const committed = isCommittedUserRow(row);
    const restore =
      onRestoreUserMessage !== undefined && committed
        ? {
            ...(userRestoreDisabledReason === undefined
              ? {}
              : { disabled: true as const, reason: userRestoreDisabledReason }),
            onRestore: () => onRestoreUserMessage(row.itemId, row.text),
          }
        : undefined;
    const branchReason = userBranchDisabledReason ?? userRestoreDisabledReason;
    const branch =
      onBranchUserMessage !== undefined && committed
        ? {
            ...(branchReason === undefined
              ? {}
              : { disabled: true as const, reason: branchReason }),
            onBranch: () => onBranchUserMessage(row.itemId, row.text),
          }
        : undefined;
    return (
      <div className="ev ev-user" data-item-id={row.itemId}>
        <div className="ev-head">
          <span className="who"><span className="role-badge u">S</span>你</span>
          <span>{formatTime(row.createdAt)}</span>
          {row.pending === "pending" ? <span className="chip gray xs">发送中</span> : null}
          {row.pending === "failed" ? <span className="chip red xs">发送失败</span> : null}
        </div>
        <UserMessageBody
          text={row.text}
          magicKeywords
          {...(row.doc === undefined ? {} : { doc: row.doc })}
          {...(row.thumbs === undefined ? {} : { thumbs: row.thumbs })}
          {...(row.text.length > 0 ? { copyText: row.text } : {})}
          {...(restore === undefined && branch === undefined && row.text.length === 0
            ? {}
            : {
                actions: (
                  <MessageUserActions
                    text={row.text}
                    {...(restore === undefined ? {} : { restore })}
                    {...(branch === undefined ? {} : { branch })}
                  />
                ),
              })}
        />
        {row.pending === "failed" && row.requestId && onRestore ? (
          <div className="err-actions">
            {row.error ? <span className="muted small">{row.error}</span> : null}
            <button type="button" className="btn small outline" onClick={() => onRestore(row.requestId as string)}>
              恢复到输入框
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  if (row.type === "assistant") {
    const changes = (
      <TurnChanges
        {...(fileChanges === undefined ? {} : { files: fileChanges })}
        {...(changesDefaultOpen === true ? { defaultOpen: true } : {})}
        {...(demo === true ? { demo: true } : {})}
        {...(onReviewChanges === undefined ? {} : { onReview: onReviewChanges })}
      />
    );
    const createdPlan = planLink === undefined ? null : (
      <PlanCreatedCard
        title={planLink.title ?? "Plan"}
        onOpen={planLink.onOpen}
        {...(planLink.demo === true || demo === true ? { demo: true } : {})}
      />
    );
    const gallery = expandAll && !hasAssistantText(row.segments);
    const displayOptions = {
      showThinking: appSettings.showThinkingSummary,
      toolActivity: appSettings.toolActivity,
      showToolIntent: appSettings.showToolIntent,
      showStreaming: appSettings.streaming,
      ...(onInspectSubagent === undefined ? {} : { onInspectSubagent }),
      ...(liveAgents === undefined ? {} : { liveAgents }),
    } as const;
    if (gallery) {
      return (
        <div data-item-id={row.itemId}>
          {renderAssistantSegments(row.segments, { expandAll: true, standalone: true, ...displayOptions })}
          {row.error ? <ProviderErrorDetail error={row.error} /> : null}
          {createdPlan}
          {changes}
        </div>
      );
    }
    const process = row.presentation === "process";
    if (process && row.segments.length === 0 && row.error === undefined && (fileChanges === undefined || fileChanges.length === 0) && planLink === undefined) {
      return null;
    }
    // 每来一个 assistant item，同一轮里上一行就从 reply 降级成 process，身份头随之
    // 出现/消失。头部必须占住一个固定的子节点位置（process 时为 null），否则段落数组
    // 会整体前移一格，React 按位置比对时会把整组工具链卸载重挂载——展开状态和动画都丢。
    return (
      <div className={`ev ev-assistant${process ? " ev-process" : ""}`} data-item-id={row.itemId}>
        {process ? null : (
          <div className="ev-head">
            <span className="who"><span className="role-badge a">π</span>OMP</span>
            <span className="muted">{formatTime(row.createdAt)}</span>
            <AssistantStatus status={row.status} />
          </div>
        )}
        {renderAssistantSegments(row.segments, {
          ...(expandAll === true && !process ? { expandAll: true } : {}),
          ...(row.status === "streaming" && tail ? { liveTail: true } : {}),
          ...displayOptions,
          ...(!process && row.status !== "streaming" ? { allowCopy: true } : {}),
        })}
        {row.error ? <ProviderErrorDetail error={row.error} /> : null}
        {createdPlan}
        {changes}
      </div>
    );
  }
  if (row.type === "compaction") {
    return <CompactionRule item={row.item} />;
  }
  if (row.type === "compacting") {
    return (
      <div className="ev" data-item-id="compacting">
        <div className="compact-rule is-pending" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>压缩中</span>
        </div>
      </div>
    );
  }
  return (
    <div className="ev" data-item-id={row.item.itemId}>
      <div className="reset-boundary-bar">
        <Icon name="commit" extra="sm" />
        <span>上下文边界</span>
        <span className="muted small">{formatTime(row.item.createdAt)}</span>
      </div>
    </div>
  );
});
