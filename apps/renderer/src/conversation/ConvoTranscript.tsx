import { ConversationItemView } from "./ConversationItemView";
import type { AssistantSegment, TimelineRow } from "./conversationViewModel";
import { collectTurnFileChanges, type SubagentHubTarget, type TurnFileChange } from "./toolMeta";

type TurnChangeBind = {
  readonly files: readonly TurnFileChange[];
  readonly defaultOpen: boolean;
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

/** Attach one change card to the last assistant row of each completed turn. */
export function turnChangeBinds(rows: readonly TimelineRow[]): ReadonlyArray<TurnChangeBind | undefined> {
  const binds: Array<TurnChangeBind | undefined> = rows.map(() => undefined);
  const latest = lastAssistantIndex(rows);
  let start = -1;

  const flush = (end: number) => {
    if (start < 0 || end <= start) {
      start = -1;
      return;
    }
    const slice = rows.slice(start, end);
    const last = slice[slice.length - 1];
    if (last?.type !== "assistant" || last.status === "streaming") {
      start = -1;
      return;
    }
    const files = collectTurnFileChanges(collectAssistantSegments(slice));
    if (files.length > 0) {
      binds[end - 1] = { files, defaultOpen: end - 1 === latest };
    }
    start = -1;
  };

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.type === "assistant") {
      if (start < 0) start = index;
      continue;
    }
    flush(index);
  }
  flush(rows.length);
  return binds;
}

export function ConvoTranscript({
  rows,
  demo,
  onRestore,
  onReviewChanges,
  onInspectSubagent,
}: {
  rows: readonly TimelineRow[];
  demo?: boolean;
  onRestore?: (requestId: string) => void;
  onReviewChanges?: () => void;
  onInspectSubagent?: (target: SubagentHubTarget) => void;
}) {
  const binds = turnChangeBinds(rows);
  return (
    <>
      {demo ? (
        <div className="convo-demo-banner">
          <span className="chip gray xs">演示</span>
          <span className="muted small">预览图鉴，不会查询 Host transcript。</span>
        </div>
      ) : null}
      {rows.map((row, index) => {
        const bind = binds[index];
        return (
          <ConversationItemView
            key={row.type === "compaction" || row.type === "resetBoundary" ? row.item.itemId : row.itemId}
            row={row}
            {...(demo === true ? { expandAll: true, demo: true } : {})}
            {...(onRestore === undefined ? {} : { onRestore })}
            {...(bind === undefined ? {} : { fileChanges: bind.files, changesDefaultOpen: bind.defaultOpen })}
            {...(onReviewChanges === undefined ? {} : { onReviewChanges })}
            {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
          />
        );
      })}
    </>
  );
}
