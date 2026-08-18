import type { BtwSnapshot } from "@omp-studio/client-contract";

/**
 * BTW demo snapshots for preview mode.
 *
 * Static strings only — none of this reaches the Host, the reducer, or the
 * client contract. The three rounds cover the states the panel renders
 * differently: a streaming answer, a finished one, and a truncated failure.
 */
export const PREVIEW_BTW_QUESTION = "为什么 SessionChanges 的 diff 会漏掉重命名？";

export const PREVIEW_BTW_SNAPSHOTS: readonly BtwSnapshot[] = [
  {
    ephemeralId: "btw-demo-running",
    status: "running",
    text: "`SessionChanges` 目前只读 `turn.diff` 里的 `path`，重命名在 Runtime 侧是一对 `oldPath` / `newPath`，",
  },
  {
    ephemeralId: "btw-demo-completed",
    status: "completed",
    text: [
      "`SessionChanges` 目前只读 `turn.diff` 里的 `path`，重命名在 Runtime 侧是一对",
      "`oldPath` / `newPath`，所以那条记录被当成「删一个、加一个」。",
      "",
      "三处要改：",
      "",
      "1. `conversationViewModel.ts` 保留 `oldPath`；",
      "2. `SessionChanges.tsx` 的分组键改成 `newPath ?? path`；",
      "3. 行渲染补一个 `oldPath → newPath` 的标签。",
    ].join("\n"),
    copy: "SessionChanges 只读 turn.diff 的 path，重命名在 Runtime 侧是 oldPath/newPath 一对。",
  },
  {
    ephemeralId: "btw-demo-failed",
    status: "failed",
    text: "答案过长，已截断。",
    error: { code: "OUTPUT_LIMIT", message: "BTW 回答超出输出上限，已停止。" },
  },
];

/** Cycle position → snapshot, so the demo control can walk the three states. */
export function previewBtwSnapshot(index: number): BtwSnapshot {
  const list = PREVIEW_BTW_SNAPSHOTS;
  const safe = ((index % list.length) + list.length) % list.length;
  return list[safe] as BtwSnapshot;
}
