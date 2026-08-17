import { describe, expect, it } from "vitest";
import type { EnvironmentId, HistoryEntryId, SessionHistoryEntry, SessionId, ThreadId } from "@omp-studio/client-contract";
import { collectHistoryRecents, collectPreviewRecents } from "./emptyRecents";

function entry(partial: Pick<SessionHistoryEntry, "historyId" | "title" | "lastActiveAt"> & Partial<SessionHistoryEntry>): SessionHistoryEntry {
  return {
    threadId: "thread-1" as ThreadId,
    environmentId: "env-1" as EnvironmentId,
    startedAt: partial.lastActiveAt,
    messageCount: 1,
    status: "active",
    ...partial,
  };
}

describe("empty-state recents", () => {
  it("preview list is the three newest non-archived threads and skips the blank t0 row", () => {
    const rows = collectPreviewRecents();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.previewThreadId)).toEqual(["t7", "t1", "t2"]);
    expect(rows.some((row) => row.previewThreadId === "t0" || row.title.includes("归档"))).toBe(false);
    expect(rows[0]?.project).toBe("omp-web (feat/mermaid)");
    expect(rows[1]?.status).toBe("running");
  });

  it("preview list honors locally hidden threads", () => {
    const rows = collectPreviewRecents(new Set(["t7"]));
    expect(rows.map((row) => row.previewThreadId)).toEqual(["t1", "t2", "t6"]);
  });

  it("history list uses lastActiveAt, drops archived rows, and marks the live session", () => {
    const rows = collectHistoryRecents({
      projectName: "omp-studio",
      runningSessionId: "sess-run",
      waitingSessionId: "sess-wait",
      now: Date.parse("2026-08-17T12:00:00.000Z"),
      entries: [
        entry({ historyId: "h-old" as HistoryEntryId, title: "旧会话", lastActiveAt: "2026-08-10T00:00:00.000Z" }),
        entry({ historyId: "h-arch" as HistoryEntryId, title: "已归档", lastActiveAt: "2026-08-17T11:00:00.000Z", status: "archived" }),
        entry({ historyId: "h-run" as HistoryEntryId, title: "运行中", lastActiveAt: "2026-08-17T11:30:00.000Z", sessionId: "sess-run" as SessionId }),
        entry({ historyId: "h-wait" as HistoryEntryId, title: "待确认", lastActiveAt: "2026-08-17T11:00:00.000Z", sessionId: "sess-wait" as SessionId }),
        entry({ historyId: "h-idle" as HistoryEntryId, title: "空闲", lastActiveAt: "2026-08-16T12:00:00.000Z" }),
      ],
    });
    expect(rows.map((row) => row.title)).toEqual(["运行中", "待确认", "空闲"]);
    expect(rows[0]).toMatchObject({ status: "running", project: "omp-studio" });
    expect(rows[1]?.status).toBe("approval");
    expect(rows[2]?.status).toBe("idle");
    expect(rows.some((row) => row.title === "已归档")).toBe(false);
  });
});
