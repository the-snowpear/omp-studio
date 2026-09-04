import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { AssistantRunView, ConversationItemView, type AssistantRunEntry } from "./ConversationItemView";
import type { AssistantSegment, TimelineRow } from "./conversationViewModel";
import { timelineRowKey, timelineShapeToken, timelineStructureToken } from "./conversationViewModel";
import {
  assistantRunRanges,
  collectPlanProposal,
  collectTurnFileChanges,
  sessionChangeTurnIdForRange,
  type SubagentHubTarget,
  type TurnFileChange,
} from "./toolMeta";
import { PlanCreatedCard, type PlanCreatedLink } from "../deck/PlanCreatedCard";
import { useCallback, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { ConversationVirtualList } from "./ConversationVirtualList";

/** One rendered transcript item plus the inputs it was built from. */
type RenderedItem = { readonly deps: readonly unknown[]; readonly element: ReactNode };

function sameDeps(previous: readonly unknown[], next: readonly unknown[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

type TurnChangeBind = {
  readonly files: readonly TurnFileChange[];
  readonly defaultOpen: boolean;
  readonly turnId: string;
};

type TranscriptRenderItem =
  | { readonly kind: "row"; readonly index: number; readonly key: string }
  | { readonly kind: "assistantRun"; readonly start: number; readonly end: number; readonly key: string };

function renderItems(rows: readonly TimelineRow[]): readonly TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index]?.type !== "assistant") {
      items.push({ kind: "row", index, key: timelineRowKey(rows[index]!) });
      index += 1;
      continue;
    }
    const start = index;
    while (index + 1 < rows.length && rows[index + 1]?.type === "assistant") index += 1;
    const end = index;
    // Key on the run's FIRST row only. Embedding the last row made the key change
    // every time another assistant message completed inside the same turn, and
    // React unmounted and remounted the whole run — every BatchChain, ToolBody and
    // MarkdownBlock (with its rehypeHighlight output) plus all `useLazyExpand`
    // state. `renderItem`'s dependency array already covers content changes, and
    // `ConversationItemView` deliberately uses positional keys for the same reason.
    items.push({ kind: "assistantRun", start, end, key: `assistant-run:${timelineRowKey(rows[start]!)}` });
    index += 1;
  }
  return items;
}

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
  onRetryTurn,
  retryTurnDisabledReason,
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
  /** 链尾 assistant 轮失败/中止时出现的「重试上一轮」；预览模式由父级不传。 */
  onRetryTurn?: () => void;
  retryTurnDisabledReason?: string;
}) {
  const structureToken = timelineStructureToken(rows);
  // `renderItems` 只按行 type 把行分成 row / assistantRun，与工具集无关，所以挂在
  // shape 令牌上：否则每次工具启停都要对全对话重算一遍分组。
  const shapeToken = timelineShapeToken(rows);
  const binds = useMemo(() => turnChangeBinds(rows), [structureToken]);
  const createdBinds = useMemo(() => planCreatedBinds(rows, planLink), [planLink, structureToken]);
  const visualItems = useMemo(() => renderItems(rows), [shapeToken]);
  /**
   * Element identity per transcript item.
   *
   * The virtualizer re-renders once per measurement it takes: once per animation
   * frame while a tool card's height transitions, and once per published frame
   * while streaming — and each of those calls `renderItem` for every mounted
   * row. Building the elements inside `renderItem` therefore re-created and
   * re-compared the entire mounted window every frame, and rows whose props
   * carry a freshly allocated callback (`onReviewChanges`) re-rendered outright
   * however deep their tool cards went. Reusing the element makes React skip the
   * subtree on reference equality alone, so a frame that only moved one row's
   * height costs one row.
   */
  const itemCache = useRef<Map<string, RenderedItem>>(new Map());
  const itemKeys = useMemo(() => {
    const keys = visualItems.map((item) => item.key);
    const live = new Set(keys);
    for (const key of itemCache.current.keys()) {
      if (!live.has(key)) itemCache.current.delete(key);
    }
    return keys;
  }, [visualItems]);
  // 只有尾行的链尾能跟随流式，上一轮的链在正文行出现后自动折叠。
  const latestAssistant = useMemo(() => lastAssistantIndex(rows), [structureToken]);
  const buildItem = useCallback(
    (visualItem: TranscriptRenderItem): ReactNode => {
      if (visualItem.kind === "assistantRun") {
        const entries: AssistantRunEntry[] = [];
        for (let rowIndex = visualItem.start; rowIndex <= visualItem.end; rowIndex += 1) {
          const candidate = rows[rowIndex];
          if (candidate?.type !== "assistant") continue;
          const bind = binds[rowIndex];
          const rowPlanLink = createdBinds[rowIndex];
          entries.push({
            row: candidate,
            ...(bind === undefined ? {} : { fileChanges: bind.files, changesDefaultOpen: bind.defaultOpen, turnId: bind.turnId }),
            ...(rowPlanLink === undefined ? {} : { planLink: rowPlanLink }),
          });
        }
        // 「重试上一轮」只挂在链尾 run 上，且仅当其最后一个 assistant 行以
        // 出错/中止收场；可见性近似，Runtime 侧 turn.retry 仍做权威判定。
        const lastRow = rows[visualItem.end];
        const retryEligible =
          onRetryTurn !== undefined
          && visualItem.end === latestAssistant
          && lastRow?.type === "assistant"
          && (lastRow.status === "error" || lastRow.status === "aborted");
        const retryTurnHere =
          retryEligible && onRetryTurn !== undefined
            ? {
                ...(retryTurnDisabledReason === undefined
                  ? {}
                  : { disabled: true as const, reason: retryTurnDisabledReason }),
                onRetry: onRetryTurn,
              }
            : undefined;
        return (
          <AssistantRunView
            entries={entries}
            {...(visualItem.end === latestAssistant ? {} : { tail: false })}
            {...(demo === true ? { expandAll: true, demo: true } : {})}
            {...(onReviewChanges === undefined ? {} : { onReviewChanges })}
            {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
            {...(liveAgents === undefined ? {} : { liveAgents })}
            {...(retryTurnHere === undefined ? {} : { retryTurn: retryTurnHere })}
          />
        );
      }
      const row = rows[visualItem.index]!;
      const bind = binds[visualItem.index];
      const rowPlanLink = createdBinds[visualItem.index];
      return (
        <ConversationItemView
          row={row}
          {...(visualItem.index === latestAssistant ? {} : { tail: false })}
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
    },
    [
      binds,
      createdBinds,
      demo,
      latestAssistant,
      liveAgents,
      onBranchUserMessage,
      onInspectSubagent,
      onRestore,
      onRestoreUserMessage,
      onReviewChanges,
      onRetryTurn,
      retryTurnDisabledReason,
      rows,
      userBranchDisabledReason,
      userRestoreDisabledReason,
    ],
  );
  const renderItem = useCallback(
    (index: number): ReactNode => {
      const visualItem = visualItems[index]!;
      const deps: unknown[] = [demo, onInspectSubagent, liveAgents, onReviewChanges];
      if (visualItem.kind === "assistantRun") {
        deps.push(visualItem.end === latestAssistant, onRetryTurn, retryTurnDisabledReason);
        for (let rowIndex = visualItem.start; rowIndex <= visualItem.end; rowIndex += 1) {
          deps.push(rows[rowIndex], binds[rowIndex], createdBinds[rowIndex]);
        }
      } else {
        deps.push(
          visualItem.index === latestAssistant,
          rows[visualItem.index],
          binds[visualItem.index],
          createdBinds[visualItem.index],
          onRestore,
          onRestoreUserMessage,
          onBranchUserMessage,
          userRestoreDisabledReason,
          userBranchDisabledReason,
        );
      }
      const cached = itemCache.current.get(visualItem.key);
      if (cached !== undefined && sameDeps(cached.deps, deps)) return cached.element;
      const element = buildItem(visualItem);
      itemCache.current.set(visualItem.key, { deps, element });
      return element;
    },
    [
      binds,
      buildItem,
      createdBinds,
      demo,
      latestAssistant,
      liveAgents,
      onBranchUserMessage,
      onInspectSubagent,
      onRestore,
      onRestoreUserMessage,
      onReviewChanges,
      onRetryTurn,
      retryTurnDisabledReason,
      rows,
      userBranchDisabledReason,
      userRestoreDisabledReason,
      visualItems,
    ],
  );
  return (
    <>
      {demo ? (
        <div className="convo-demo-banner">
          <span className="chip gray xs">演示</span>
        </div>
      ) : null}
      <ConversationVirtualList
        {...(scrollerRef === undefined || demo ? {} : { scrollerRef })}
        itemKeys={itemKeys}
        renderItem={renderItem}
      />
      {planLink !== undefined && planLink.attachEvenWithoutPropose === true && latestAssistant < 0 ? (
        <PlanCreatedCard
          title={planLink.title ?? "Plan"}
          onOpen={planLink.onOpen}
          {...(planLink.demo === true || demo === true ? { demo: true } : {})}
        />
      ) : null}
    </>
  );
}
