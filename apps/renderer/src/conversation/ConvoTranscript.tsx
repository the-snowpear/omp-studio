import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ConversationItemView } from "./ConversationItemView";
import type { AssistantSegment, TimelineRow } from "./conversationViewModel";
import { timelineRowKey } from "./conversationViewModel";
import {
  assistantRunRanges,
  collectPlanProposal,
  collectTurnFileChanges,
  sessionChangeTurnIdForRange,
  collectAgents,
  type SubagentHubTarget,
  type TurnFileChange,
} from "./toolMeta";
import { PlanCreatedCard, type PlanCreatedLink } from "../deck/PlanCreatedCard";
import {
  VIRTUAL_CONVERSATION_REVEAL_EVENT,
  type VirtualConversationRevealDetail,
} from "./virtualConversationReveal";
import { captureAnchor, distanceFromBottom } from "./useConversationScroll";
import {
  recallSessionConversation,
  rememberSessionViewport,
  timelineRowsSignature,
} from "./sessionConversationCache";
import type {
  ConversationRowMeasurement,
  ConversationViewportController,
} from "./conversationViewportController";

const FIRST_ITEM_INDEX_BASE = 1_000_000;

export function firstItemIndexAfterRows(
  previousRows: readonly TimelineRow[],
  nextRows: readonly TimelineRow[],
  current: number,
): number {
  const previousFirst = previousRows[0];
  if (previousFirst === undefined) return current;
  const prepended = nextRows.findIndex((row) => timelineRowKey(row) === timelineRowKey(previousFirst));
  if (prepended > 0) return Math.max(1, current - prepended);
  return prepended < 0 ? FIRST_ITEM_INDEX_BASE : current;
}

type TurnChangeBind = {
  readonly files: readonly TurnFileChange[];
  readonly defaultOpen: boolean;
  readonly turnId: string;
};

const rowNeedsLiveAgentsCache = new WeakMap<object, boolean>();
const turnChangeBindCache = new WeakMap<object, Map<string, {
  readonly rows: readonly TimelineRow[];
  readonly bind: TurnChangeBind;
}>>();
const planProposalCache = new WeakMap<object, { readonly proposal: ReturnType<typeof collectPlanProposal> }>();
const planLinkCache = new WeakMap<object, WeakMap<object, PlanCreatedLink>>();
const reviewHandlerCache = new WeakMap<object, WeakMap<object, () => void>>();

function rowNeedsLiveAgents(row: TimelineRow): boolean {
  if (typeof row !== "object" || row.type !== "assistant") return false;
  const cached = rowNeedsLiveAgentsCache.get(row);
  if (cached !== undefined) return cached;
  let needed = false;
  for (const segment of row.segments) {
    if (segment.type === "batch" && collectAgents(segment.tools).length > 0) {
      needed = true;
      break;
    }
  }
  rowNeedsLiveAgentsCache.set(row, needed);
  return needed;
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

function sameRows(left: readonly TimelineRow[], right: readonly TimelineRow[]): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

function cachedTurnChangeBind(
  slice: readonly TimelineRow[],
  defaultOpen: boolean,
  turnId: string,
): TurnChangeBind | undefined {
  const cacheKey = slice[slice.length - 1];
  if (cacheKey === undefined || typeof cacheKey !== "object") return undefined;
  const variant = `${defaultOpen ? "open" : "closed"}:${turnId}`;
  const variants = turnChangeBindCache.get(cacheKey);
  const cached = variants?.get(variant);
  if (cached !== undefined && sameRows(cached.rows, slice)) return cached.bind;
  const files = collectTurnFileChanges(collectAssistantSegments(slice));
  if (files.length === 0) return undefined;
  const bind = { files, defaultOpen, turnId };
  const nextVariants = variants ?? new Map();
  nextVariants.set(variant, { rows: slice, bind });
  if (variants === undefined) turnChangeBindCache.set(cacheKey, nextVariants);
  return bind;
}

/** Attach one change card to the last assistant row of each completed turn. */
export function turnChangeBinds(rows: readonly TimelineRow[]): ReadonlyArray<TurnChangeBind | undefined> {
  const binds: Array<TurnChangeBind | undefined> = rows.map(() => undefined);
  const ranges = assistantRunRanges(rows);
  const latest = lastAssistantIndex(rows);

  for (const range of ranges) {
    const slice = rows.slice(range.start, range.end + 1);
    if (!turnSliceClosed(slice)) continue;
    binds[range.end] = cachedTurnChangeBind(
      slice,
      range.end === latest,
      sessionChangeTurnIdForRange(rows, range, ranges),
    );
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

function cachedPlanProposal(row: Extract<TimelineRow, { type: "assistant" }>) {
  const cached = planProposalCache.get(row);
  if (cached !== undefined) return cached.proposal;
  const proposal = collectPlanProposal(row.segments);
  planProposalCache.set(row, { proposal });
  return proposal;
}

function cachedResolvedPlanLink(row: object, planLink: PlanCreatedLink, title: string): PlanCreatedLink {
  let byPlanLink = planLinkCache.get(row);
  if (byPlanLink === undefined) {
    byPlanLink = new WeakMap();
    planLinkCache.set(row, byPlanLink);
  }
  const cached = byPlanLink.get(planLink);
  if (cached !== undefined) return cached;
  const resolved = resolvedPlanLink(planLink, title);
  byPlanLink.set(planLink, resolved);
  return resolved;
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
    const proposal = cachedPlanProposal(row);
    if (proposal === undefined) continue;
    binds[index] = cachedResolvedPlanLink(row, planLink, planLink.title?.trim() || proposal.title);
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
  scrollParent,
  viewIdentity,
  header,
  footer,
  viewportController,
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
  viewIdentity?: string;
  header?: ReactNode;
  footer?: ReactNode;
  viewportController?: ConversationViewportController;
  /** `undefined` keeps the deterministic non-virtual test/embedded path. */
  scrollParent?: HTMLElement | null;
}) {
  const virtualRef = useRef<VirtuosoHandle | null>(null);
  const rowSignature = useMemo(() => timelineRowsSignature(rows), [rows]);
  const initialCache = useMemo(
    () => viewIdentity === undefined ? undefined : recallSessionConversation(viewIdentity),
    [viewIdentity],
  );
  const firstItemIndexRef = useRef(initialCache?.viewport?.firstItemIndex ?? FIRST_ITEM_INDEX_BASE);
  const previousRowsRef = useRef<{ identity?: string; rows: readonly TimelineRow[] }>({
    ...(viewIdentity === undefined ? {} : { identity: viewIdentity }),
    rows,
  });
  if (previousRowsRef.current.identity !== viewIdentity) {
    firstItemIndexRef.current = initialCache?.viewport?.firstItemIndex ?? FIRST_ITEM_INDEX_BASE;
    previousRowsRef.current = { ...(viewIdentity === undefined ? {} : { identity: viewIdentity }), rows };
  } else if (previousRowsRef.current.rows !== rows) {
    firstItemIndexRef.current = firstItemIndexAfterRows(
      previousRowsRef.current.rows,
      rows,
      firstItemIndexRef.current,
    );
    previousRowsRef.current = { ...(viewIdentity === undefined ? {} : { identity: viewIdentity }), rows };
  }
  const firstItemIndex = firstItemIndexRef.current;
  const restoreState = initialCache?.viewport?.rowSignature === rowSignature && initialCache.viewport.atBottom === false
    ? initialCache.viewport.virtuosoState
    : undefined;
  const semanticRestoreDoneRef = useRef(false);
  const viewportCaptureRef = useRef({ firstItemIndex, rowSignature });
  viewportCaptureRef.current = { firstItemIndex, rowSignature };
  const totalListHeightRef = useRef(0);
  const latestRenderedMeasurementsRef = useRef<readonly ConversationRowMeasurement[]>([]);
  const viewportItemIds = useMemo(() => rows.map(timelineRowKey), [rows]);
  const measuredItemIdsRef = useRef<readonly string[]>(viewportItemIds);
  if (
    measuredItemIdsRef.current.length !== viewportItemIds.length
    || measuredItemIdsRef.current.some((itemId, index) => itemId !== viewportItemIds[index])
  ) {
    // Do not combine a new physical window with the previous window's height.
    // Virtuoso may publish itemsRendered before its new total height.
    measuredItemIdsRef.current = viewportItemIds;
    totalListHeightRef.current = 0;
    latestRenderedMeasurementsRef.current = [];
  }
  // 流式期间父级每帧重渲染，这几张表只跟 rows / planLink 变：不 memo 的话每帧都会
  // 重算，而且每行都拿到新的 bind 对象与新的 onReviewChanges 闭包，把
  // ConversationItemView 的 memo 击穿。
  const binds = useMemo(() => turnChangeBinds(rows), [rows]);
  const createdBinds = useMemo(() => planCreatedBinds(rows, planLink), [rows, planLink]);
  const reviewHandlers = useMemo(() => {
    const handlers = new Map<string, () => void>();
    if (onReviewChanges === undefined) return handlers;
    for (const bind of binds) {
      if (bind === undefined || handlers.has(bind.turnId)) continue;
      let byBind = reviewHandlerCache.get(onReviewChanges);
      if (byBind === undefined) {
        byBind = new WeakMap();
        reviewHandlerCache.set(onReviewChanges, byBind);
      }
      let handler = byBind.get(bind);
      if (handler === undefined) {
        const turnId = bind.turnId;
        handler = () => onReviewChanges(turnId);
        byBind.set(bind, handler);
      }
      handlers.set(bind.turnId, handler);
    }
    return handlers;
  }, [binds, onReviewChanges]);
  // 只有尾行的链尾能跟随流式，上一轮的链在正文行出现后自动折叠。
  const latestAssistant = useMemo(() => lastAssistantIndex(rows), [rows]);
  const renderRow = (absoluteIndex: number, row: TimelineRow) => {
        const index = absoluteIndex - firstItemIndex;
        const bind = binds[index];
        const rowPlanLink = createdBinds[index];
        const onReview = bind === undefined ? undefined : reviewHandlers.get(bind.turnId);
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
            {...(onReview === undefined ? {} : { onReviewChanges: onReview })}
            {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
            {...(liveAgents === undefined || !rowNeedsLiveAgents(row) ? {} : { liveAgents })}
            {...(rowPlanLink === undefined ? {} : { planLink: rowPlanLink })}
          />
        );
  };
  const trailingPlan = planLink !== undefined && planLink.attachEvenWithoutPropose === true && latestAssistant < 0 ? (
    <PlanCreatedCard
      title={planLink.title ?? "Plan"}
      onOpen={planLink.onOpen}
      {...(planLink.demo === true || demo === true ? { demo: true } : {})}
    />
  ) : null;
  const virtuosoComponents = useMemo(() => ({
    Header: () => (
      <>
        {demo ? <div className="convo-demo-banner"><span className="chip gray xs">演示</span></div> : null}
        {header}
      </>
    ),
    Footer: () => <>{trailingPlan}{footer}</>,
  }), [demo, footer, header, trailingPlan]);
  useEffect(() => {
    if (scrollParent === undefined || scrollParent === null) return;
    let frame: number | undefined;
    const onReveal = (raw: Event) => {
      const event = raw as CustomEvent<VirtualConversationRevealDetail>;
      const index = rows.findIndex((row) => timelineRowKey(row) === event.detail.itemId);
      if (index < 0) return;
      event.preventDefault();
      virtualRef.current?.scrollToIndex({ index: firstItemIndex + index, align: "center", behavior: "smooth" });
      let attempts = 0;
      const finish = () => {
        const node = scrollParent.querySelector<HTMLElement>(`[data-item-id="${cssEscape(event.detail.itemId)}"]`);
        if (node !== null) {
          const tool = event.detail.toolCallId === undefined
            ? null
            : node.querySelector<HTMLElement>(`[data-tool-call-id="${cssEscape(event.detail.toolCallId)}"]`);
          if (tool !== null && !tool.classList.contains("open")) {
            tool.querySelector<HTMLButtonElement>("button.tl-row")?.click();
          }
          const target = tool ?? node;
          target.classList.remove("mm-flash");
          void target.offsetWidth;
          target.classList.add("mm-flash");
          window.setTimeout(() => target.classList.remove("mm-flash"), 900);
          return;
        }
        attempts += 1;
        if (attempts < 12) frame = requestAnimationFrame(finish);
      };
      frame = requestAnimationFrame(finish);
    };
    scrollParent.addEventListener(VIRTUAL_CONVERSATION_REVEAL_EVENT, onReveal);
    return () => {
      scrollParent.removeEventListener(VIRTUAL_CONVERSATION_REVEAL_EVENT, onReveal);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [firstItemIndex, rows, scrollParent]);
  useLayoutEffect(() => {
    if (
      semanticRestoreDoneRef.current ||
      scrollParent === undefined ||
      scrollParent === null ||
      initialCache?.viewport === undefined
    ) return;
    const viewport = initialCache.viewport;
    if (viewport.atBottom) {
      semanticRestoreDoneRef.current = true;
      virtualRef.current?.scrollToIndex({ index: firstItemIndex + rows.length - 1, align: "end" });
      return;
    }
    if (viewport.rowSignature === rowSignature && viewport.virtuosoState !== undefined) return;
    const anchor = viewport.anchor;
    if (anchor === undefined) return;
    const index = rows.findIndex((row) => timelineRowKey(row) === anchor.itemId);
    if (index < 0) return;
    semanticRestoreDoneRef.current = true;
    virtualRef.current?.scrollToIndex({ index: firstItemIndex + index, align: "start" });
    const frame = requestAnimationFrame(() => {
      const node = scrollParent.querySelector<HTMLElement>(`[data-item-id="${cssEscape(anchor.itemId)}"]`);
      if (node === null) return;
      const delta = node.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) > 0.5) scrollParent.scrollTop += delta;
    });
    return () => cancelAnimationFrame(frame);
  }, [firstItemIndex, initialCache, rowSignature, rows, scrollParent]);
  useLayoutEffect(() => {
    if (viewIdentity === undefined || scrollParent === undefined || scrollParent === null) return;
    return () => {
      const anchor = captureAnchor(scrollParent);
      const atBottom = distanceFromBottom(scrollParent) <= 1;
      virtualRef.current?.getState((virtuosoState) => {
        const latest = viewportCaptureRef.current;
        rememberSessionViewport(viewIdentity, {
          atBottom,
          ...(anchor === null ? {} : { anchor }),
          firstItemIndex: latest.firstItemIndex,
          rowSignature: latest.rowSignature,
          virtuosoState,
        });
      });
    };
  }, [scrollParent, viewIdentity]);
  if (scrollParent === null) return null;
  if (scrollParent !== undefined && typeof ResizeObserver === "function") {
    return (
      <>
        <Virtuoso
          ref={virtualRef}
          customScrollParent={scrollParent}
          data={rows}
          firstItemIndex={firstItemIndex}
          {...(restoreState === undefined ? {} : { restoreStateFrom: restoreState })}
          components={virtuosoComponents}
          computeItemKey={(_index, row) => timelineRowKey(row)}
          itemContent={renderRow}
          {...(viewportController === undefined ? {} : {
            itemsRendered: (items) => {
              const measurements = items.flatMap((item) => item.data === undefined ? [] : [{
                itemId: timelineRowKey(item.data),
                offset: item.offset,
                size: item.size,
              }]);
              latestRenderedMeasurementsRef.current = measurements;
              viewportController.setItems(viewportItemIds);
              const totalHeight = totalListHeightRef.current;
              if (totalHeight <= 0) return;
              viewportController.recordMeasurements(measurements, totalHeight);
            },
            totalListHeightChanged: (height) => {
              totalListHeightRef.current = height;
              viewportController.setItems(viewportItemIds);
              // Flush the latest rendered set even when Virtuoso delivered it
              // before this first height callback. Waiting for another scroll
              // would leave the minimap on interpolation/stale offsets.
              viewportController.recordMeasurements(latestRenderedMeasurementsRef.current, height);
            },
          })}
          increaseViewportBy={{ top: 720, bottom: 960 }}
        />
      </>
    );
  }
  return (
    <>
      {demo ? <div className="convo-demo-banner"><span className="chip gray xs">演示</span></div> : null}
      {header}
      {rows.map((row, index) => renderRow(firstItemIndex + index, row))}
      {trailingPlan}{footer}
    </>
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}
