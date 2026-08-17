import type { ReactNode } from "react";
import type { ConversationMessageError } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useAppSettings, type ToolActivityDetail } from "../settings/appSettings";
import { BatchChain } from "./BatchChain";
import { TruncationMark } from "./ToolBody";
import { MarkdownText } from "./markdown";
import { TurnDiffCard } from "./TurnDiffCard";
import type { AssistantSegment, TimelineRow, ToolView } from "./conversationViewModel";
import type { SubagentHubTarget, ThinkView, TurnFileChange } from "./toolMeta";

function formatTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBody({
  text,
  streaming,
  truncated,
  magicKeywords,
}: {
  text: string;
  streaming?: boolean;
  truncated?: boolean;
  magicKeywords?: boolean;
}) {
  return (
    <MarkdownText
      text={text}
      {...(streaming === true ? { streaming: true } : {})}
      {...(truncated === true ? { truncated: true, mark: <TruncationMark /> } : {})}
      {...(magicKeywords === true ? { magicKeywords: true } : {})}
    />
  );
}

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

function renderAssistantSegments(
  segments: readonly AssistantSegment[],
  options: {
    expandAll?: boolean;
    standalone?: boolean;
    streaming?: boolean;
    /** 设置 → 对话与交互：显示 Thinking 摘要。 */
    showThinking?: boolean;
    /** 设置 → 常规：工具活动显示（full 展开 / concise 默认 / hidden 隐藏工具链）。 */
    toolActivity?: ToolActivityDetail;
    /** 设置 → 对话与交互：显示工具调用意图。 */
    showToolIntent?: boolean;
    /** 设置 → 常规：流式输出（关闭后不带流式光标渲染）。 */
    showStreaming?: boolean;
    onInspectSubagent?: (target: SubagentHubTarget) => void;
  } = {},
): ReactNode[] {
  const showThinking = options.showThinking !== false;
  const showStreaming = options.showStreaming !== false;
  const toolActivity = options.toolActivity ?? "concise";
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index]!;
    if (segment.type === "text") {
      nodes.push(
        <MessageBody
          key={segment.key}
          text={segment.text}
          {...(showStreaming && segment.streaming === true ? { streaming: true } : {})}
          {...(segment.truncated === true ? { truncated: true } : {})}
        />,
      );
      index += 1;
      continue;
    }
    const thinking: ThinkView[] = [];
    const tools: ToolView[] = [];
    const batchKey = segment.key;
    while (index < segments.length && segments[index]?.type !== "text") {
      const process = segments[index]!;
      if (process.type === "thinking" && process.text.length > 0) {
        if (showThinking) {
          thinking.push({
            key: process.key,
            text: process.text,
            ...(process.truncated === true ? { truncated: true } : {}),
          });
        }
      } else if (process.type === "batch") {
        if (toolActivity !== "hidden") tools.push(...process.tools);
      }
      index += 1;
    }
    if (thinking.length === 0 && tools.length === 0) continue;
    // 该组之后没有别的段落（即 AI 尚未开始输出其后的文本段）时视为流式尾部链。
    const liveTail = options.streaming === true && index >= segments.length;
    const chainExpandAll = options.expandAll === true || toolActivity === "full";
    nodes.push(
      <BatchChain
        key={batchKey}
        batchKey={batchKey}
        tools={tools}
        thinking={thinking}
        {...(chainExpandAll ? { expandAll: true } : {})}
        {...(options.standalone === true ? { standalone: true } : {})}
        {...(liveTail ? { liveTail: true } : {})}
        {...(options.showToolIntent === false ? { showDetail: false } : {})}
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

export function ConversationItemView({
  row,
  onRestore,
  expandAll = false,
  fileChanges,
  changesDefaultOpen,
  demo,
  onReviewChanges,
  onInspectSubagent,
}: {
  row: TimelineRow;
  onRestore?: (requestId: string) => void;
  expandAll?: boolean;
  fileChanges?: readonly TurnFileChange[];
  changesDefaultOpen?: boolean;
  demo?: boolean;
  onReviewChanges?: () => void;
  onInspectSubagent?: (target: SubagentHubTarget) => void;
}) {
  const { settings: appSettings } = useAppSettings();
  if (row.type === "user") {
    return (
      <div className="ev ev-user" data-item-id={row.itemId}>
        <div className="ev-head">
          <span className="who"><span className="role-badge u">S</span>你</span>
          <span>{formatTime(row.createdAt)}</span>
          {row.pending === "pending" ? <span className="chip gray xs">发送中</span> : null}
          {row.pending === "failed" ? <span className="chip red xs">发送失败</span> : null}
        </div>
        <MessageBody text={row.text} magicKeywords />
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
    const gallery = expandAll && !hasAssistantText(row.segments);
    const displayOptions = {
      showThinking: appSettings.showThinkingSummary,
      toolActivity: appSettings.toolActivity,
      showToolIntent: appSettings.showToolIntent,
      showStreaming: appSettings.streaming,
      ...(onInspectSubagent === undefined ? {} : { onInspectSubagent }),
    } as const;
    if (gallery) {
      return (
        <div data-item-id={row.itemId}>
          {renderAssistantSegments(row.segments, { expandAll: true, standalone: true, ...displayOptions })}
          {row.error ? <ProviderErrorDetail error={row.error} /> : null}
          {changes}
        </div>
      );
    }
    if (row.presentation === "process") {
      if (row.segments.length === 0 && row.error === undefined && (fileChanges === undefined || fileChanges.length === 0)) return null;
      return (
        <div className="ev ev-assistant ev-process" data-item-id={row.itemId}>
          {renderAssistantSegments(row.segments, row.status === "streaming" ? { streaming: true, ...displayOptions } : displayOptions)}
          {row.error ? <ProviderErrorDetail error={row.error} /> : null}
          {changes}
        </div>
      );
    }
    return (
      <div className="ev ev-assistant" data-item-id={row.itemId}>
        <div className="ev-head">
          <span className="who"><span className="role-badge a">π</span>OMP</span>
          <span className="muted">{formatTime(row.createdAt)}</span>
          <AssistantStatus status={row.status} />
        </div>
        {renderAssistantSegments(row.segments, {
          ...(expandAll === true ? { expandAll: true } : {}),
          ...(row.status === "streaming" ? { streaming: true } : {}),
          ...displayOptions,
        })}
        {row.error ? <ProviderErrorDetail error={row.error} /> : null}
        {changes}
      </div>
    );
  }
  if (row.type === "compaction") {
    return (
      <div className="ev" data-item-id={row.item.itemId}>
        <div className="compact-bar">
          <Icon name="minimize" extra="sm" />
          <span><b>Compact</b> · {row.item.shortSummary ?? row.item.summary}</span>
        </div>
        {row.item.warning ? <p className="muted small">{row.item.warning}</p> : null}
        <p className="convo-plain small">{row.item.summary}</p>
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
}
