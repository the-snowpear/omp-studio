import { AnnotationButton } from "../annotations/Annotations";
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { afterConversationLayoutChange, beforeConversationLayoutChange } from "./conversationReflow";

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
      {...(truncated === true ? { truncated: true, mark: <TruncationMark /> } : {})}
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
}

function AdvisorMessage({ row, open: controlledOpen, onToggle }: {
  row: Extract<TimelineRow, { type: "advisor" }>;
  open?: boolean;
  onToggle?: (itemId: string, defaultOpen: boolean) => void;
}) {
  const { t } = useI18n();
  const bodyId = useId();
  const defaultOpen = row.notes.some(note => note.severity === "blocker");
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const previousOpen = useRef(open);
  useLayoutEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    afterConversationLayoutChange();
  }, [open]);
  const noteLabel = (note: (typeof row.notes)[number]) => [
    t("conversation.advisor"), note.advisor,
    note.severity && t(`conversation.advisorSeverity.${note.severity}`),
  ].filter(Boolean).join(" · ");

  if (row.notes.length <= 1) return <div className="ev ev-advisor-group" data-item-id={row.itemId}>
    {row.notes.map((note, index) => <aside className="ev-advisor" key={index} aria-label={noteLabel(note)}>
        <div className="ev-head">
          <span className="who"><Icon name="alert" extra="sm" />{noteLabel(note)}</span>
          <span>{formatTime(row.createdAt)}</span>
          <MessageCopyButton text={`${noteLabel(note)}\n${note.text}`} />
        </div>
        <div className="ev-advisor-text">{note.text}{note.truncated && <TruncationMark />}</div>
      </aside>)}
  </div>;

  const source = row.notes[0]?.advisor;
  const label = [t("conversation.advisor"), source && row.notes.every(note => note.advisor === source) ? source : undefined].filter(Boolean).join(" · ");
  const counts = (["blocker", "concern", "nit", "note"] as const).flatMap(severity => {
    const count = row.notes.filter(note => (note.severity ?? "note") === severity).length;
    return count ? [{ severity, text: t(`conversation.advisorCount.${severity}${count === 1 ? "One" : "Other"}`, { count }) }] : [];
  });
  const summary = [label, ...counts.map(count => count.text)].join(" · ");
  return <aside className="ev ev-advisor ev-advisor-batch" data-item-id={row.itemId} data-severity={counts[0]?.severity} aria-label={summary}>
    <div className="ev-advisor-batch-head">
      <button type="button" className="ev-advisor-toggle" aria-expanded={open} aria-controls={bodyId}
        aria-label={t(open ? "conversation.advisorBatch.collapse" : "conversation.advisorBatch.expand", { summary })}
        onClick={() => {
          beforeConversationLayoutChange();
          if (onToggle) onToggle(row.itemId, defaultOpen);
          else setLocalOpen(!open);
        }}>
        <Icon name="chevron-r" extra="sm ev-advisor-chevron" />
        <span className="ev-advisor-summary">
          <span className="ev-advisor-title"><Icon name="alert" extra="sm" />{label}</span>
          <span className="ev-advisor-counts">{counts.map(count => <span key={count.severity} data-severity={count.severity}>{count.text}</span>)}</span>
        </span>
      </button>
      <span className="ev-advisor-batch-time">{formatTime(row.createdAt)}</span>
      <MessageCopyButton label={t("conversation.advisorBatch.copy")} text={row.notes.map(note => `${noteLabel(note)}\n${note.text}`).join("\n\n")} />
    </div>
    <div id={bodyId} hidden={!open}>
      {open ? <ol className="ev-advisor-notes">{row.notes.map((note, index) => <li className="ev-advisor-note" key={index} aria-label={noteLabel(note)}>
        <div className="ev-head">
          <span className="ev-advisor-note-label">{[note.advisor, note.severity && t(`conversation.advisorSeverity.${note.severity}`)].filter(Boolean).join(" · ")}</span>
          <MessageCopyButton text={`${noteLabel(note)}\n${note.text}`} />
        </div>
        <div className="ev-advisor-text">{note.text}{note.truncated && <TruncationMark />}</div>
      </li>)}</ol> : null}
    </div>
  </aside>;
}

function AssistantStatus({ status }: { status: Extract<TimelineRow, { type: "assistant" }>["status"] }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  if (status === "aborted") return <span className="chip gray xs">{zh ? "已中止" : "Aborted"}</span>;
  if (status === "error") return <span className="chip red xs">{zh ? "出错" : "Error"}</span>;
  return null;
}

function ProviderErrorDetail({ error }: { error: ConversationMessageError }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const meta = [error.status !== undefined ? String(error.status) : undefined, error.provider, error.model]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" · ");
  return (
    <div className="ev-provider-error">
      {error.source === "agentLoop" ? <div className="chip amber xs">{zh ? "Agent 执行流程错误" : "Agent loop error"}</div> : null}
      {meta ? <div className="muted small">{meta}</div> : null}
      <p className="ev-provider-error-text">{error.message}</p>
    </div>
  );
}

function hasAssistantText(segments: readonly AssistantSegment[]): boolean {
  return segments.some((segment) => segment.type === "text" && segment.text.length > 0);
}

function concludingReplyText(segments: readonly AssistantSegment[]): Extract<AssistantSegment, { type: "text" }> | undefined {
  let last: Extract<AssistantSegment, { type: "text" }> | undefined;
  for (const segment of segments) {
    if (segment.type === "batch") {
      last = undefined;
      continue;
    }
    if (segment.type === "text" && segment.text.length > 0) last = segment;
  }
  return last;
}

export function MessageCopyButton({ text, label }: { text: string; label?: string }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
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
      aria-label={copied ? (zh ? "已复制" : "Copied") : label ?? (zh ? "复制消息" : "Copy message")}
      data-tip={copied ? (zh ? "已复制" : "Copied") : label ?? (zh ? "复制" : "Copy")}
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
      <AnnotationButton small source={{ kind: "message", label: "Reply", text }} />
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

export type RowPlanBind = {
  /** Inline plan cards keyed by the `write xd://propose` `toolCallId` in this row. */
  readonly byToolCallId?: Readonly<Record<string, PlanCreatedLink>>;
  /** Row-tail fallback used only when `attachEvenWithoutPropose` has no `xd://propose` call. */
  readonly fallback?: PlanCreatedLink;
};

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
    inlinePlans?: Readonly<Record<string, PlanCreatedLink>>;
    demo?: boolean;
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
  let planCount = 0;
  while (index < segments.length) {
    const segment = segments[index]!;
    if (segment.type === "text") {
      nodes.push(
        <MessageBody
          key={`body-${bodyCount}`}
          text={segment.text}
          {...(showStreaming && segment.streaming === true ? { streaming: true } : {})}
          {...(segment.truncated === true ? { truncated: true } : {})}
          {...(lastText === segment ? { copyText: lastText.text } : {})}
        />,
      );
      bodyCount += 1;
      index += 1;
      continue;
    }
    // 一条链里的思考与工具保持模型产出顺序：只有中间没被工具打断的连续思考才合成
    // 一张卡，否则工具跑完之后的思考会被并进工具之前的思考里。
    // 遇到 `write xd://propose` 时先把规划阶段链收束输出，在提交处内联插入计划卡，
    // 批准后的执行阶段思考与工具链继续排在计划卡下方。
    let items: ChainItem[] = [];
    let pendingThink: ThinkView | undefined;
    const flushThink = () => {
      if (pendingThink === undefined) return;
      items.push({ kind: "think", think: pendingThink });
      pendingThink = undefined;
    };
    const flushChain = (isEndOfSegments: boolean) => {
      flushThink();
      if (items.length === 0) return;
      const batchKey = `chain-${chainCount}`;
      chainCount += 1;
      // 该组之后没有别的段落或内联计划卡（即 AI 尚未开始输出其后的段落），且该行是
      // transcript 尾行、仍在流式输出时，才视为流式尾部链。
      const liveTail = options.liveTail === true && isEndOfSegments;
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
      items = [];
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
      } else if (process.type === "batch" && process.tools.length > 0) {
        for (const tool of process.tools) {
          const inlinePlan = options.inlinePlans?.[tool.toolCallId];
          if (inlinePlan !== undefined) {
            flushChain(false);
            nodes.push(
              <PlanCreatedCard
                key={`plan-${planCount}`}
                toolCallId={tool.toolCallId}
                title={inlinePlan.title ?? "Plan"}
                onOpen={inlinePlan.onOpen}
                {...(inlinePlan.demo === true || options.demo === true ? { demo: true } : {})}
              />,
            );
            planCount += 1;
            continue;
          }
          if (toolActivity !== "hidden") {
            flushThink();
            items.push({ kind: "tool", tool });
          }
        }
      }
      index += 1;
    }
    flushChain(index >= segments.length);
  }
  return nodes;
}

export type AssistantRunEntry = {
  readonly row: Extract<TimelineRow, { type: "assistant" }>;
  readonly fileChanges?: readonly TurnFileChange[];
  readonly changesDefaultOpen?: boolean;
  readonly turnId?: string;
  readonly planBind?: RowPlanBind;
  readonly planLink?: PlanCreatedLink;
};

/** Render one visual assistant response for all assistant rows in a turn. */
function AssistantRunViewInner({
  entries,
  expandAll = false,
  tail = true,
  demo,
  onReviewChanges,
  onInspectSubagent,
  liveAgents,
  retryTurn,
}: {
  entries: readonly AssistantRunEntry[];
  expandAll?: boolean;
  tail?: boolean;
  demo?: boolean;
  onReviewChanges?: (turnId: string) => void;
  onInspectSubagent?: (target: SubagentHubTarget) => void;
  liveAgents?: readonly StudioAgentSnapshot[];
  /** 链尾失败/中止时的「重试上一轮」操作；父级只在最后一个 run 上提供。 */
  retryTurn?: {
    disabled?: boolean;
    reason?: string;
    onRetry: () => void;
  };
}) {
  const { t } = useI18n();
  const { settings: appSettings } = useAppSettings();
  const first = entries[0];
  const last = entries.at(-1);
  if (first === undefined || last === undefined) return null;
  const segments = entries.flatMap((entry) => entry.row.segments);
  let inlinePlans: Record<string, PlanCreatedLink> | undefined;
  for (const entry of entries) {
    if (entry.planBind?.byToolCallId !== undefined) {
      inlinePlans = inlinePlans === undefined
        ? { ...entry.planBind.byToolCallId }
        : { ...inlinePlans, ...entry.planBind.byToolCallId };
    }
  }
  const displayOptions = {
    showThinking: appSettings.showThinkingSummary,
    toolActivity: appSettings.toolActivity,
    showToolIntent: appSettings.showToolIntent,
    showStreaming: appSettings.streaming,
    ...(onInspectSubagent === undefined ? {} : { onInspectSubagent }),
    ...(liveAgents === undefined ? {} : { liveAgents }),
    ...(inlinePlans === undefined ? {} : { inlinePlans }),
    ...(demo === true ? { demo: true } : {}),
  } as const;
  const process = entries.every((entry) => entry.row.presentation === "process");
  const gallery = entries.length === 1 && expandAll && !hasAssistantText(segments);
  const changes = entries.map((entry) => entry.fileChanges === undefined || entry.fileChanges.length === 0 ? null : (
    <TurnChanges
      key={`changes-${entry.row.itemId}`}
      files={entry.fileChanges}
      {...(entry.changesDefaultOpen === true ? { defaultOpen: true } : {})}
      {...(demo === true ? { demo: true } : {})}
      {...(onReviewChanges === undefined || entry.turnId === undefined ? {} : { onReview: () => onReviewChanges(entry.turnId as string) })}
    />
  ));
  const plans = entries.map((entry) => {
    const fallbackPlan = entry.planBind?.fallback ?? entry.planLink;
    return fallbackPlan === undefined ? null : (
      <PlanCreatedCard
        key={`plan-${entry.row.itemId}`}
        title={fallbackPlan.title ?? "Plan"}
        onOpen={fallbackPlan.onOpen}
        {...(fallbackPlan.demo === true || demo === true ? { demo: true } : {})}
      />
    );
  });
  const errors = entries.map((entry) => entry.row.error === undefined ? null : <ProviderErrorDetail key={`error-${entry.row.itemId}`} error={entry.row.error} />);
  if (gallery) {
    return <div data-item-id={first.row.itemId}>{renderAssistantSegments(segments, { expandAll: true, standalone: true, ...displayOptions })}{errors}{plans}{changes}{retryTurn === undefined ? null : (
      <div className="ev-msg-actions ev-retry-actions">
        <button
          type="button"
          className="ev-msg-copy"
          aria-label={t("conversation.retryTurn")}
          data-tip={
            retryTurn.disabled === true
              ? (retryTurn.reason ?? t("conversation.retryTurnUnavailable"))
              : t("conversation.retryTurn")
          }
          disabled={retryTurn.disabled === true}
          onClick={retryTurn.onRetry}
        >
          <Icon name="undo" extra="sm" />
        </button>
      </div>
    )}</div>;
  }
  if (process && segments.length === 0 && errors.every((entry) => entry === null) && changes.every((entry) => entry === null) && plans.every((entry) => entry === null)) return null;
  return (
    <div className={`ev ev-assistant${process ? " ev-process" : ""}`} data-item-id={first.row.itemId}>
      {process ? null : (
        <div className="ev-head">
          <span className="who"><span className="role-badge a">π</span>OMP</span>
          <span className="muted">{formatTime(first.row.createdAt)}</span>
          <AssistantStatus status={last.row.status} />
        </div>
      )}
      {renderAssistantSegments(segments, {
        ...(expandAll === true && !process ? { expandAll: true } : {}),
        /* liveTail 语义：轮次还在进行（streaming，或 item 已落盘但 turnOpen——
           两次模型请求之间的间隔）时尾链保持展开，直到下一条正文出现或轮次结束。 */
        ...((last.row.status === "streaming" || last.row.turnOpen === true) && tail ? { liveTail: true } : {}),
        ...displayOptions,
        ...(!process && last.row.status !== "streaming" ? { allowCopy: true } : {}),
      })}
      {errors}
      {plans}
      {changes}
      {retryTurn === undefined ? null : (
        <div className="ev-msg-actions ev-retry-actions">
          <button
            type="button"
            className="ev-msg-copy"
            aria-label={t("conversation.retryTurn")}
            data-tip={
              retryTurn.disabled === true
                ? (retryTurn.reason ?? t("conversation.retryTurnUnavailable"))
                : t("conversation.retryTurn")
            }
            disabled={retryTurn.disabled === true}
            onClick={retryTurn.onRetry}
          >
            <Icon name="undo" extra="sm" />
          </button>
        </div>
      )}
    </div>
  );
}

export const AssistantRunView = memo(AssistantRunViewInner, (previous, next) => {
  if (previous.expandAll !== next.expandAll || previous.tail !== next.tail || previous.demo !== next.demo) return false;
  if (previous.onReviewChanges !== next.onReviewChanges || previous.onInspectSubagent !== next.onInspectSubagent || previous.liveAgents !== next.liveAgents) return false;
  if (previous.retryTurn?.disabled !== next.retryTurn?.disabled || previous.retryTurn?.reason !== next.retryTurn?.reason) return false;
  if (previous.retryTurn?.onRetry !== next.retryTurn?.onRetry) return false;
  if (previous.entries.length !== next.entries.length) return false;
  for (let index = 0; index < previous.entries.length; index += 1) {
    const left = previous.entries[index]!;
    const right = next.entries[index]!;
    if (left.row !== right.row || left.fileChanges !== right.fileChanges || left.changesDefaultOpen !== right.changesDefaultOpen || left.turnId !== right.turnId || left.planBind !== right.planBind || left.planLink !== right.planLink) return false;
  }
  return true;
});

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
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(false);
  const label = compactRuleLabel(item, zh);
  const summary = (item.summary.trim() || item.shortSummary?.trim() || "");
  const foldable = compactSummaryFoldable(item, zh);
  const showBody = summary.length > 0 && (foldable ? open : summary !== label);
  return (
    <div className="ev" data-item-id={item.itemId}>
      {foldable ? (
        <button
          type="button"
          className={`compact-rule${open ? " is-open" : ""}`}
          aria-expanded={open}
          aria-label={zh ? `Compact · ${label}，${open ? "收起" : "展开"}详情` : `Compact · ${label}, ${open ? "collapse" : "expand"} details`}
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
  planBind,
  planLink,
  advisorOpen,
  onToggleAdvisor,
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
  planBind?: RowPlanBind;
  planLink?: PlanCreatedLink;
  advisorOpen?: boolean;
  onToggleAdvisor?: (itemId: string, defaultOpen: boolean) => void;
}) {
  const { settings: appSettings } = useAppSettings();
  const { resolvedLanguage } = useI18n();
  if (row.type === "advisor") return <AdvisorMessage row={row} {...(advisorOpen === undefined ? {} : { open: advisorOpen })} {...(onToggleAdvisor === undefined ? {} : { onToggle: onToggleAdvisor })} />;
  if (row.type === "extension") return <div className="ev ev-extension" data-item-id={row.itemId}>
    <div className="ev-head"><span className="who">{row.asyncNotify ? resolvedLanguage === "zh" ? "后台输出通知" : "Background output" : resolvedLanguage === "zh" ? "扩展通知" : "Extension notice"}</span>{row.excludeFromContext && <span className="chip gray xs ev-context-excluded" data-tip={resolvedLanguage === "zh" ? "这条消息只显示在界面里，模型看不到" : "Shown here only. The model does not see this message."}><Icon name="eye-off" extra="xs" />{resolvedLanguage === "zh" ? "仅界面可见" : "UI only"}</span>}<span>{formatTime(row.createdAt)}</span></div>
    <MessageBody text={row.text} copyText={row.text} />
  </div>;
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
    // Branch has its own gate: unlike restore it stays available while a turn streams.
    const branchReason = userBranchDisabledReason;
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
          <span className="who"><span className="role-badge u">S</span>{resolvedLanguage === "zh" ? "你" : "You"}</span>
          <span>{formatTime(row.createdAt)}</span>
          {row.pending === "pending" ? <span className="chip gray xs">{resolvedLanguage === "zh" ? "发送中" : "Sending"}</span> : null}
          {row.pending === "failed" ? <span className="chip red xs">{resolvedLanguage === "zh" ? "发送失败" : "Failed"}</span> : null}
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
              {resolvedLanguage === "zh" ? "恢复到输入框" : "Restore to composer"}
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
    const fallbackPlan = planBind?.fallback ?? planLink;
    const createdPlan = fallbackPlan === undefined ? null : (
      <PlanCreatedCard
        title={fallbackPlan.title ?? "Plan"}
        onOpen={fallbackPlan.onOpen}
        {...(fallbackPlan.demo === true || demo === true ? { demo: true } : {})}
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
      ...(planBind?.byToolCallId === undefined ? {} : { inlinePlans: planBind.byToolCallId }),
      ...(demo === true ? { demo: true } : {}),
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
    if (process && row.segments.length === 0 && row.error === undefined && (fileChanges === undefined || fileChanges.length === 0) && fallbackPlan === undefined) {
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
          ...((row.status === "streaming" || row.turnOpen === true) && tail ? { liveTail: true } : {}),
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
          <span>{resolvedLanguage === "zh" ? "压缩中" : "Compacting"}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="ev" data-item-id={row.item.itemId}>
      <div className="reset-boundary-bar">
        <Icon name="commit" extra="sm" />
        <span>{resolvedLanguage === "zh" ? "上下文边界" : "Context boundary"}</span>
        <span className="muted small">{formatTime(row.item.createdAt)}</span>
      </div>
    </div>
  );
});
