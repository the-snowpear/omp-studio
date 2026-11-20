import { InlineBtwNotes } from "../btw/InlineBtwNote";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { AssistantRunView, ConversationItemView, type AssistantRunEntry, type RowPlanBind } from "./ConversationItemView";
import { jsonString, timelineRowKey, timelineShapeToken, timelineStructureToken, type AssistantSegment, type TimelineRow } from "./conversationViewModel";
import {
  assistantRunRanges,
  collectTurnFileChanges,
  isPlanProposeTool,
  planArtifactWriteContent,
  planProposalRawTitle,
  sessionChangeTurnIdForRange,
  toolFields,
  type SubagentHubTarget,
  type TurnFileChange,
} from "./toolMeta";
import { PlanCreatedCard, type PlanCreatedLink } from "../deck/PlanCreatedCard";
import { useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { CONVERSATION_REVEAL, revealMountedConversationItem, type ConversationRevealRequest } from "./conversationReveal";
import { ConversationVirtualList } from "./ConversationVirtualList";
import { usePreviewMode } from "../preview/PreviewContext";

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

export type TurnChangeCacheEntry = {
  readonly sliceRows: readonly TimelineRow[];
  readonly defaultOpen: boolean;
  readonly turnId: string;
  readonly bind: TurnChangeBind | undefined;
};

/** Attach one change card to the last assistant row of each completed turn. */
export function turnChangeBinds(
  rows: readonly TimelineRow[],
  cache?: Map<string, TurnChangeCacheEntry>,
): ReadonlyArray<TurnChangeBind | undefined> {
  const binds: Array<TurnChangeBind | undefined> = rows.map(() => undefined);
  const ranges = assistantRunRanges(rows);
  const latest = lastAssistantIndex(rows);
  const seenKeys = cache ? new Set<string>() : undefined;

  for (const range of ranges) {
    const slice = rows.slice(range.start, range.end + 1);
    if (!turnSliceClosed(slice)) continue;
    const defaultOpen = range.end === latest;
    const turnId = sessionChangeTurnIdForRange(rows, range, ranges);
    const cacheKey = `${timelineRowKey(rows[range.start]!)}:${turnId}`;
    seenKeys?.add(cacheKey);
    const previous = cache?.get(cacheKey);
    if (
      previous !== undefined
      && previous.defaultOpen === defaultOpen
      && previous.turnId === turnId
      && sameDeps(previous.sliceRows, slice)
    ) {
      binds[range.end] = previous.bind;
      continue;
    }
    const files = collectTurnFileChanges(collectAssistantSegments(slice));
    const bind: TurnChangeBind | undefined = files.length === 0 ? undefined : { files, defaultOpen, turnId };
    cache?.set(cacheKey, { sliceRows: slice, defaultOpen, turnId, bind });
    binds[range.end] = bind;
  }
  if (cache && seenKeys) {
    for (const key of cache.keys()) {
      if (!seenKeys.has(key)) cache.delete(key);
    }
  }
  return binds;
}

function resolvedPlanLink(planLink: PlanCreatedLink, title: string, body?: string): PlanCreatedLink {
  return {
    onOpen: (origin) => planLink.onOpen(origin, body !== undefined ? { title, body } : undefined),
    title,
    ...(body === undefined ? {} : { body }),
    ...(planLink.demo === true ? { demo: true } : {}),
  };
}

export type PlanBindCacheEntry = {
  readonly sig: string;
  readonly linkRef: PlanCreatedLink;
  readonly bind: RowPlanBind;
};

/**
 * Pin each Created Plan card inline at the exact `write xd://propose` tool call.
 * After approval the execution turn continues below the card in the same assistant run;
 * `read xd://propose` doc lookups are ignored, and `attachEvenWithoutPropose` only
 * falls back to the tail row when no `xd://propose` exists in the transcript.
 */
export function planCreatedBinds(
  rows: readonly TimelineRow[],
  planLink?: PlanCreatedLink,
  cache?: Map<string, PlanBindCacheEntry>,
): ReadonlyArray<RowPlanBind | undefined> {
  const binds: Array<RowPlanBind | undefined> = rows.map(() => undefined);
  if (planLink === undefined) return binds;

  type MatchedProposal = {
    readonly rowIndex: number;
    readonly toolCallId: string;
    readonly rawTitle: string | undefined;
    readonly body: string | undefined;
  };
  const proposals: MatchedProposal[] = [];
  let runningBody = "";

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.type !== "assistant") {
      runningBody = "";
      continue;
    }
    for (const segment of row.segments) {
      if (segment.type !== "batch") continue;
      for (const call of segment.tools) {
        if (call.status === "failed" || call.status === "aborted" || call.status === "missing") continue;
        const written = planArtifactWriteContent(call);
        if (written !== undefined) {
          runningBody = written;
          continue;
        }
        if (!isPlanProposeTool(call)) continue;
        const proposedBody = jsonString(toolFields(call).planContent);
        if (proposedBody !== undefined && proposedBody.length > 0) runningBody = proposedBody;
        const resolvedBody =
          proposedBody !== undefined && proposedBody.length > 0
            ? proposedBody
            : runningBody.length > 0
              ? runningBody
              : undefined;
        proposals.push({
          rowIndex,
          toolCallId: call.toolCallId,
          rawTitle: planProposalRawTitle(call),
          body: resolvedBody,
        });
      }
    }
  }

  if (proposals.length > 0) {
    const grouped = new Map<number, { sigParts: string[]; map: Record<string, PlanCreatedLink> }>();
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index]!;
      const isLast = index === proposals.length - 1;
      const title = proposal.rawTitle || (isLast ? planLink.title?.trim() : undefined) || "Plan";
      const body = proposal.body ?? (isLast ? planLink.body : undefined);
      let entry = grouped.get(proposal.rowIndex);
      if (entry === undefined) {
        entry = { sigParts: [], map: {} };
        grouped.set(proposal.rowIndex, entry);
      }
      entry.sigParts.push(`${proposal.toolCallId}\0${title}\0${body ?? ""}\0${planLink.demo === true ? "1" : "0"}`);
      entry.map[proposal.toolCallId] = resolvedPlanLink(planLink, title, body);
    }
    for (const [rowIndex, entry] of grouped) {
      const row = rows[rowIndex];
      const cacheKey = row?.type === "assistant" ? `inline:${row.itemId}` : `inline:${rowIndex}`;
      const sig = entry.sigParts.join("\n");
      const previous = cache?.get(cacheKey);
      if (previous !== undefined && previous.sig === sig && previous.linkRef === planLink) {
        binds[rowIndex] = previous.bind;
      } else {
        const bind: RowPlanBind = { byToolCallId: entry.map };
        cache?.set(cacheKey, { sig, linkRef: planLink, bind });
        binds[rowIndex] = bind;
      }
    }
    return binds;
  }

  if (planLink.attachEvenWithoutPropose === true) {
    const last = lastAssistantIndex(rows);
    if (last >= 0) {
      const title = planLink.title?.trim() || "Plan";
      const body = planLink.body;
      const row = rows[last];
      const cacheKey = row?.type === "assistant" ? `fallback:${row.itemId}` : `fallback:${last}`;
      const sig = `${title}\0${body ?? ""}\0${planLink.demo === true ? "1" : "0"}`;
      const previous = cache?.get(cacheKey);
      if (previous !== undefined && previous.sig === sig && previous.linkRef === planLink) {
        binds[last] = previous.bind;
      } else {
        const bind: RowPlanBind = { fallback: resolvedPlanLink(planLink, title, body) };
        cache?.set(cacheKey, { sig, linkRef: planLink, bind });
        binds[last] = bind;
      }
    }
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
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  const structureToken = timelineStructureToken(rows);
  // `renderItems` 只按行 type 把行分成 row / assistantRun，与工具集无关，所以挂在
  // shape 令牌上：否则每次工具启停都要对全对话重算一遍分组。
  const shapeToken = timelineShapeToken(rows);
  const turnBindCacheRef = useRef<Map<string, TurnChangeCacheEntry>>(new Map());
  const binds = useMemo(() => turnChangeBinds(rows, turnBindCacheRef.current), [structureToken]);
  const planBindCacheRef = useRef<Map<string, PlanBindCacheEntry>>(new Map());
  const createdBinds = useMemo(() => {
    const cache = planBindCacheRef.current;
    const result = planCreatedBinds(rows, planLink, cache);
    if (cache.size > rows.length + 8) {
      const liveIds = new Set<string>();
      for (const row of rows) {
        if (row.type === "assistant") {
          liveIds.add(`inline:${row.itemId}`);
          liveIds.add(`fallback:${row.itemId}`);
        }
      }
      for (const key of cache.keys()) {
        if (!liveIds.has(key)) cache.delete(key);
      }
    }
    return result;
  }, [planLink, structureToken]);
  const visualItems = useMemo(() => renderItems(rows), [shapeToken]);
  const revealRef = useRef<((index: number, mounted: () => void) => void) | null>(null);
  const revealData = useRef({ rows, visualItems });
  revealData.current = { rows, visualItems };
  useEffect(() => {
    const scroller = scrollerRef?.current;
    if (!scroller) return;
    const reveal = (event: Event) => {
      event.preventDefault();
      const request = (event as CustomEvent<ConversationRevealRequest>).detail;
      const current = revealData.current;
      const rowIndex = current.rows.findIndex(row => request.itemId !== undefined
        ? timelineRowKey(row) === request.itemId
        : row.type === "assistant" && row.segments.some(segment => segment.type === "batch" && segment.tools.some(tool => tool.toolCallId === request.toolCallId)));
      const row = current.rows[rowIndex];
      const index = current.visualItems.findIndex(item => item.kind === "row" ? item.index === rowIndex : item.start <= rowIndex && item.end >= rowIndex);
      if (row === undefined || index < 0 || revealRef.current === null) { request.finish(false); return; }
      revealRef.current(index, () => revealMountedConversationItem(scroller, { ...request, itemId: timelineRowKey(row) }));
    };
    scroller.addEventListener(CONVERSATION_REVEAL, reveal);
    return () => scroller.removeEventListener(CONVERSATION_REVEAL, reveal);
  }, [scrollerRef]);
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
          const rowPlanBind = createdBinds[rowIndex];
          entries.push({
            row: candidate,
            ...(bind === undefined ? {} : { fileChanges: bind.files, changesDefaultOpen: bind.defaultOpen, turnId: bind.turnId }),
            ...(rowPlanBind === undefined ? {} : { planBind: rowPlanBind }),
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
      const rowPlanBind = createdBinds[visualItem.index];
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
          {...(rowPlanBind === undefined ? {} : { planBind: rowPlanBind })}
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
      const anchoredRows = visualItem.kind === "assistantRun" ? rows.slice(visualItem.start, visualItem.end + 1) : [rows[visualItem.index]!];
      const ids = anchoredRows.flatMap(row => "itemId" in row ? [row.itemId] : []);
      const element = <>{buildItem(visualItem)}<InlineBtwNotes itemIds={ids} /></>;
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
      {demo === true && marks ? (
        <div className="convo-demo-banner">
          <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
        </div>
      ) : null}
      <ConversationVirtualList
        revealRef={revealRef}
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
