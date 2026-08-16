import type { ReactNode } from "react";
import { Icon } from "../icons";
import { BatchChain } from "./BatchChain";
import { TruncationMark } from "./ToolBody";
import { MarkdownText } from "./markdown";
import type { AssistantSegment, TimelineRow, ToolView } from "./conversationViewModel";
import type { ThinkView } from "./toolMeta";

function formatTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBody({ text, streaming, truncated }: { text: string; streaming?: boolean; truncated?: boolean }) {
  return (
    <MarkdownText
      text={text}
      {...(streaming === true ? { streaming: true } : {})}
      {...(truncated === true ? { truncated: true, mark: <TruncationMark /> } : {})}
    />
  );
}

function AssistantStatus({ status }: { status: Extract<TimelineRow, { type: "assistant" }>["status"] }) {
  if (status === "streaming") return <span className="chip blue xs">流式输出中</span>;
  if (status === "aborted") return <span className="chip gray xs">已中止</span>;
  if (status === "error") return <span className="chip red xs">出错</span>;
  return null;
}

function hasAssistantText(segments: readonly AssistantSegment[]): boolean {
  return segments.some((segment) => segment.type === "text" && segment.text.length > 0);
}

function renderAssistantSegments(
  segments: readonly AssistantSegment[],
  options: { expandAll?: boolean; standalone?: boolean } = {},
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index]!;
    if (segment.type === "text") {
      nodes.push(
        <MessageBody
          key={segment.key}
          text={segment.text}
          {...(segment.streaming === true ? { streaming: true } : {})}
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
        thinking.push({
          key: process.key,
          text: process.text,
          ...(process.truncated === true ? { truncated: true } : {}),
        });
      } else if (process.type === "batch") {
        tools.push(...process.tools);
      }
      index += 1;
    }
    if (thinking.length === 0 && tools.length === 0) continue;
    nodes.push(
      <BatchChain
        key={batchKey}
        batchKey={batchKey}
        tools={tools}
        thinking={thinking}
        {...(options.expandAll === true ? { expandAll: true } : {})}
        {...(options.standalone === true ? { standalone: true } : {})}
      />,
    );
  }
  return nodes;
}

export function ConversationItemView({
  row,
  onRestore,
  expandAll = false,
}: {
  row: TimelineRow;
  onRestore?: (requestId: string) => void;
  expandAll?: boolean;
}) {
  if (row.type === "user") {
    return (
      <div className="ev ev-user" data-item-id={row.itemId}>
        <div className="ev-head">
          <span className="who"><span className="role-badge u">S</span>你</span>
          <span>{formatTime(row.createdAt)}</span>
          {row.pending === "pending" ? <span className="chip gray xs">发送中</span> : null}
          {row.pending === "failed" ? <span className="chip red xs">发送失败</span> : null}
        </div>
        <MessageBody text={row.text} />
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
    const gallery = expandAll && !hasAssistantText(row.segments);
    if (gallery) {
      return (
        <div data-item-id={row.itemId}>
          {renderAssistantSegments(row.segments, { expandAll: true, standalone: true })}
        </div>
      );
    }
    if (row.presentation === "process") {
      if (row.segments.length === 0) return null;
      return (
        <div className="ev ev-assistant ev-process" data-item-id={row.itemId}>
          {renderAssistantSegments(row.segments)}
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
        {renderAssistantSegments(row.segments, expandAll ? { expandAll: true } : {})}
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
