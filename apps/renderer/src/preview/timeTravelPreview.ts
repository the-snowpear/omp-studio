import type {
  SessionHistoryEntry,
  TimeTravelSettings,
  TimeTravelTimeline,
  TimeTravelRestorePreview,
} from "@omp-studio/client-contract";
import { isZh } from "../i18n";
import { getPreviewHistory, getPreviewTimeTravel } from "./fixtures";

const sessionId = "preview-time-travel" as SessionHistoryEntry["sessionId"];

function buildTimeline(zh: boolean): TimeTravelTimeline {
  const nodes = getPreviewTimeTravel(zh);
  return {
    sessionId: sessionId!,
    activeLeafId: "event-7",
    selectedLeafId: "event-7",
    branches: [],
    events: nodes.flatMap((node, index) =>
      node.kind === "checkpoint"
        ? []
        : [
            {
              id: `event-${index}`,
              parentId: index ? `event-${index - 1}` : null,
              createdAt: `2026-11-08T${node.time}:00+08:00`,
              kind:
                node.kind === "user"
                  ? ("user" as const)
                  : node.kind === "plan"
                    ? ("assistant" as const)
                    : ("tool" as const),
              title: node.title,
              detail: node.detail,
            },
          ],
    ),
    points: nodes.flatMap((node, index) =>
      node.kind !== "checkpoint"
        ? []
        : [
            {
              id: `point-${index}`,
              leafId: `event-${index - 1}`,
              phase: "after" as const,
              createdAt: `2026-11-08T${node.time}:00+08:00`,
              fileCount: index === 5 ? 3 : 4,
              changes: {
                added: index === 5 ? 2 : 0,
                modified: index === 5 ? 1 : 1,
                deleted: 0,
              },
            },
          ],
    ),
  };
}

let settings: TimeTravelSettings = {
  enabled: false,
  retentionDays: null,
  exclusions: [],
};
const listeners = new Set<() => void>();
export const timeTravelPreview = {
  get entry(): SessionHistoryEntry {
    return {
      historyId: "preview-history",
      threadId: "preview-thread",
      environmentId: "preview",
      sessionId,
      title: getPreviewHistory()[0]!.title,
      startedAt: "2026-11-08T14:02:00+08:00",
      lastActiveAt: "2026-11-08T14:09:00+08:00",
      messageCount: 8,
      status: "active",
    } as SessionHistoryEntry;
  },
  get timeline(): TimeTravelTimeline {
    return buildTimeline(isZh());
  },
  restorePreview(snapshotId: string): TimeTravelRestorePreview {
    return {
      snapshotId,
      revision: "preview",
      changes: [
        { path: "docs/UPSTREAM-SYNC.md", kind: "modify" },
        { path: "README.md", kind: "modify" },
        { path: "components/MermaidBlock.tsx", kind: "delete" },
      ],
    };
  },
  storage: { snapshots: 13, bytes: 18 * 1024 * 1024 },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSettings: () => settings,
  update(patch: Partial<TimeTravelSettings>) {
    settings = { ...settings, ...patch };
    for (const listener of listeners) listener();
  },
};
