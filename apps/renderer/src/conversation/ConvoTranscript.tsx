import {
  memo,
  useMemo,
  type RefObject,
} from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { ConversationItemView } from "./ConversationItemView";
import type { AssistantSegment, TimelineRow } from "./conversationViewModel";
import { timelineRowKey } from "./conversationViewModel";
import {
  assistantRunRanges,
  collectPlanProposal,
  collectTurnFileChanges,
  sessionChangeTurnIdForRange,
  type PlanProposal,
  type SubagentHubTarget,
  type TurnFileChange,
} from "./toolMeta";
import { PlanCreatedCard, type PlanCreatedLink } from "../deck/PlanCreatedCard";

type TurnChangeBind = {
  readonly files: readonly TurnFileChange[];
  readonly defaultOpen: boolean;
  readonly turnId: string;
};

function lastAssistantIndex(rows: readonly TimelineRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.type === "assistant") return index;
  }
  return -1;
}

function collectAssistantSegments(rows: readonly TimelineRow[]): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (const row of rows) {
    if (row.type === "assistant") segments.push(...row.segments);
  }
  return segments;
}

function turnSliceClosed(slice: readonly TimelineRow[]): boolean {
  const last = slice[slice.length - 1];
  if (last?.type !== "assistant" || last.status === "streaming") return false;
  return !slice.some((row) => row.type === "assistant" && row.turnOpen === true);
}

function sameRowSlice(left: readonly TimelineRow[], right: readonly TimelineRow[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 每轮文件改动的缓存，键为该轮最后一行。`rowReuse` 保证已完成轮次的行对象身份不变，
 * 于是流式期间这里只是指针比对。没有它的话，每个 chunk 都要把整条时间线的 segment
 * 摊平重新收集一遍，而且新数组身份会顶掉 `ConversationItemView` 的 memo。
 */
const turnFilesCache = new WeakMap<
  TimelineRow,
  { readonly rows: readonly TimelineRow[]; readonly files: readonly TurnFileChange[] }
>();

function turnFilesOf(endRow: TimelineRow, slice: readonly TimelineRow[]): readonly TurnFileChange[] {
  const cached = turnFilesCache.get(endRow);
  if (cached !== undefined && sameRowSlice(cached.rows, slice)) return cached.files;
  const files = collectTurnFileChanges(collectAssistantSegments(slice));
  turnFilesCache.set(endRow, { rows: slice, files });
  return files;
}

/** Attach one change card to the last assistant row of each completed turn. */
export function turnChangeBinds(rows: readonly TimelineRow[]): ReadonlyArray<TurnChangeBind | undefined> {
  const binds: Array<TurnChangeBind | undefined> = rows.map(() => undefined);
  const ranges = assistantRunRanges(rows);
  const latest = lastAssistantIndex(rows);

  for (const range of ranges) {
    const endRow = rows[range.end];
    if (endRow === undefined) continue;
    const slice = rows.slice(range.start, range.end + 1);
    if (!turnSliceClosed(slice)) continue;
    const files = turnFilesOf(endRow, slice);
    if (files.length === 0) continue;
    binds[range.end] = {
      files,
      defaultOpen: range.end === latest,
      turnId: sessionChangeTurnIdForRange(rows, range, ranges),
    };
  }
  return binds;
}

function resolvedPlanLink(planLink: PlanCreatedLink, title: string): PlanCreatedLink {
  return {
    onOpen: planLink.onOpen,
    title,
    ...(planLink.demo === true ? { demo: true } : {}),
  };
}

/** 计划提案只在行对象变化时重算。 */
const planProposalCache = new WeakMap<TimelineRow, { readonly value: PlanProposal | undefined }>();

function planProposalOf(row: Extract<TimelineRow, { type: "assistant" }>): PlanProposal | undefined {
  const cached = planProposalCache.get(row);
  if (cached !== undefined) return cached.value;
  const value = collectPlanProposal(row.segments);
  planProposalCache.set(row, { value });
  return value;
}

/**
 * Pin the Created Plan card on the assistant row that actually ran `xd://propose`.
 * After approval the execution turn may continue in the same assistant run;
 * do not follow `range.end` to the latest message.
 */
export function planCreatedBinds(
  rows: readonly TimelineRow[],
  planLink?: PlanCreatedLink,
): ReadonlyArray<PlanCreatedLink | undefined> {
  const binds: Array<PlanCreatedLink | undefined> = rows.map(() => undefined);
  if (planLink === undefined) return binds;
  let attached = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.type !== "assistant") continue;
    const proposal = planProposalOf(row);
    if (proposal === undefined) continue;
    binds[index] = resolvedPlanLink(planLink, planLink.title?.trim() || proposal.title);
    attached = true;
  }
  if (!attached && planLink.attachEvenWithoutPropose === true) {
    const last = lastAssistantIndex(rows);
    if (last >= 0) binds[last] = resolvedPlanLink(planLink, planLink.title?.trim() || "Plan");
  }
  return binds;
}

export const ConvoTranscript = memo(function ConvoTranscript({
  scrollerRef,
  rows,
  demo,
  onRestore,
  onRestoreUserMessage,
  onBranchUserMessage,
  userRestoreDisabledReason,
  userBranchDisabledReason,
  onReviewChanges,
  onInspectSubagent,
  liveAgents,
  planLink,
}: {
  scrollerRef?: RefObject<HTMLElement | null>;
  rows: readonly TimelineRow[];
  demo?: boolean;
  onRestore?: (requestId: string) => void;
  onRestoreUserMessage?: (itemId: string, text: string) => void;
  onBranchUserMessage?: (itemId: string, text: string) => void;
  userRestoreDisabledReason?: string;
  userBranchDisabledReason?: string;
  onReviewChanges?: (turnId: string) => void;
  onInspectSubagent?: (target: SubagentHubTarget) => void;
  liveAgents?: readonly StudioAgentSnapshot[];
  planLink?: PlanCreatedLink;
}) {
  const binds = useMemo(() => turnChangeBinds(rows), [rows]);
  const createdBinds = useMemo(() => planCreatedBinds(rows, planLink), [rows, planLink]);
  // 只有尾行的链尾能跟随流式，上一轮的链在正文行出现后自动折叠。
  const latestAssistant = useMemo(() => lastAssistantIndex(rows), [rows]);
  const keys = useMemo(() => rows.map(timelineRowKey), [rows]);

  // TODO: row virtualization removed — renders all rows
  return (
    <>
      {demo ? (
        <div className="convo-demo-banner">
          <span className="chip gray xs">演示</span>
        </div>
      ) : null}
      {rows.map((row, index) => {
        const key = keys[index]!;
        const bind = binds[index];
        const rowPlanLink = createdBinds[index];
        return (
          <ConversationItemView
            key={key}
            row={row}
            {...(index === latestAssistant ? {} : { tail: false })}
            {...(demo === true ? { expandAll: true, demo: true } : {})}
            {...(onRestore === undefined ? {} : { onRestore })}
            {...(onRestoreUserMessage === undefined ? {} : { onRestoreUserMessage })}
            {...(onBranchUserMessage === undefined ? {} : { onBranchUserMessage })}
            {...(userRestoreDisabledReason === undefined ? {} : { userRestoreDisabledReason })}
            {...(userBranchDisabledReason === undefined ? {} : { userBranchDisabledReason })}
            {...(bind === undefined ? {} : { fileChanges: bind.files, changesDefaultOpen: bind.defaultOpen })}
            {...(onReviewChanges === undefined || bind === undefined
              ? {}
              : { onReviewChanges, changesTurnId: bind.turnId })}
            {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
            {...(liveAgents === undefined ? {} : { liveAgents })}
            {...(rowPlanLink === undefined ? {} : { planLink: rowPlanLink })}
          />
        );
      })}
      {planLink !== undefined && planLink.attachEvenWithoutPropose === true && latestAssistant < 0 ? (
        <PlanCreatedCard
          title={planLink.title ?? "Plan"}
          onOpen={planLink.onOpen}
          {...(planLink.demo === true || demo === true ? { demo: true } : {})}
        />
      ) : null}
    </>
  );
});
