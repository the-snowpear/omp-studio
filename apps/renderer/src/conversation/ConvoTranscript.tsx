import { ConversationItemView } from "./ConversationItemView";
import type { TimelineRow } from "./conversationViewModel";

export function ConvoTranscript({
  rows,
  demo,
  onRestore,
}: {
  rows: readonly TimelineRow[];
  demo?: boolean;
  onRestore?: (requestId: string) => void;
}) {
  return (
    <>
      {demo ? (
        <div className="convo-demo-banner">
          <span className="chip gray xs">演示</span>
          <span className="muted small">预览图鉴，不会查询 Host transcript。</span>
        </div>
      ) : null}
      {rows.map((row) => (
        <ConversationItemView
          key={row.type === "compaction" || row.type === "resetBoundary" ? row.item.itemId : row.itemId}
          row={row}
          {...(demo === true ? { expandAll: true } : {})}
          {...(onRestore === undefined ? {} : { onRestore })}
        />
      ))}
    </>
  );
}
