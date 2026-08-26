import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { ConversationItemView } from "./ConversationItemView";
import type { AssistantSegment, TimelineRow } from "./conversationViewModel";
import { timelineRowKey } from "./conversationViewModel";
import {
  assistantRunRanges,
  collectPlanProposal,
  collectTurnFileChanges,
  sessionChangeTurnIdForRange,
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

/** Attach one change card to the last assistant row of each completed turn. */
export function turnChangeBinds(rows: readonly TimelineRow[]): ReadonlyArray<TurnChangeBind | undefined> {
  const binds: Array<TurnChangeBind | undefined> = rows.map(() => undefined);
  const ranges = assistantRunRanges(rows);
  const latest = lastAssistantIndex(rows);

  for (const range of ranges) {
    const slice = rows.slice(range.start, range.end + 1);
    if (!turnSliceClosed(slice)) continue;
    const files = collectTurnFileChanges(collectAssistantSegments(slice));
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
    const proposal = collectPlanProposal(row.segments);
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

export function ConvoTranscript({
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
  const binds = turnChangeBinds(rows);
  const createdBinds = planCreatedBinds(rows, planLink);
  // 只有尾行的链尾能跟随流式，上一轮的链在正文行出现后自动折叠。
  const latestAssistant = lastAssistantIndex(rows);
  return (
    <>
      {demo ? (
        <div className="convo-demo-banner">
          <span className="chip gray xs">演示</span>
        </div>
      ) : null}
      {rows.map((row, index) => {
        const bind = binds[index];
        const rowPlanLink = createdBinds[index];
        return (
          <ConversationItemView
            key={timelineRowKey(row)}
            row={row}
            {...(index === latestAssistant ? {} : { tail: false })}
            {...(demo === true ? { expandAll: true, demo: true } : {})}
            {...(onRestore === undefined ? {} : { onRestore })}
            {...(onRestoreUserMessage === undefined ? {} : { onRestoreUserMessage })}
            {...(onBranchUserMessage === undefined ? {} : { onBranchUserMessage })}
            {...(userRestoreDisabledReason === undefined ? {} : { userRestoreDisabledReason })}
            {...(userBranchDisabledReason === undefined ? {} : { userBranchDisabledReason })}
            {...(bind === undefined ? {} : { fileChanges: bind.files, changesDefaultOpen: bind.defaultOpen })}
            {...(onReviewChanges === undefined || bind === undefined ? {} : { onReviewChanges: () => onReviewChanges(bind.turnId) })}
            {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
            {...(liveAgents === undefined ? {} : { liveAgents })}
            {...(rowPlanLink === undefined ? {} : { planLink: rowPlanLink })}
          />
        );
      })}
      {planLink !== undefined && planLink.attachEvenWithoutPropose === true && lastAssistantIndex(rows) < 0 ? (
        <PlanCreatedCard
          title={planLink.title ?? "Plan"}
          onOpen={planLink.onOpen}
          {...(planLink.demo === true || demo === true ? { demo: true } : {})}
        />
      ) : null}
    </>
  );
}
