import { describe, expect, it } from "vitest";
import type { SessionHistoryReadModel, SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { renameNeedsSessionResume, workspaceForSession } from "./sessionTitle";

const sessionId = "session-1" as SessionId;
const workspace = (value: string) => value as WorkspaceId;

function history(title: string): SessionHistoryReadModel {
  return {
    total: 1,
    entries: [{
      historyId: "history-1" as SessionHistoryReadModel["entries"][number]["historyId"],
      threadId: "thread-1" as SessionHistoryReadModel["entries"][number]["threadId"],
      environmentId: "environment-1" as SessionHistoryReadModel["entries"][number]["environmentId"],
      sessionId,
      title,
      startedAt: "2026-08-24T00:00:00.000Z",
      lastActiveAt: "2026-08-24T00:00:00.000Z",
      messageCount: 1,
      status: "active",
    }],
  };
}

describe("session title renderer seam", () => {
  it("prefers resident workspace, then cache membership, then project fallbacks", () => {
    expect(workspaceForSession({
      sessionId,
      residentWorkspaceId: workspace("resident"),
      projectHistoryCache: {},
      selectedWorkspaceId: workspace("selected"),
      activeWorkspaceId: workspace("active"),
    })).toBe(workspace("resident"));

    expect(workspaceForSession({
      sessionId,
      projectHistoryCache: {
        [workspace("cached")]: { status: "ready", requestedLimit: 6, model: history("title") },
      },
      selectedWorkspaceId: workspace("selected"),
      activeWorkspaceId: workspace("active"),
    })).toBe(workspace("cached"));

    expect(workspaceForSession({
      projectHistoryCache: {},
      selectedWorkspaceId: workspace("selected"),
      activeWorkspaceId: workspace("active"),
    })).toBe(workspace("selected"));
  });

  it("resumes a viewed history session before rename when another Runtime is live", () => {
    expect(renameNeedsSessionResume({
      hasViewedHistory: true,
      viewedSessionId: sessionId,
      liveSessionId: "session-other" as SessionId,
    })).toBe(true);
    expect(renameNeedsSessionResume({
      hasViewedHistory: true,
      viewedSessionId: sessionId,
      liveSessionId: sessionId,
    })).toBe(false);
    expect(renameNeedsSessionResume({
      hasViewedHistory: false,
      liveSessionId: "session-other" as SessionId,
    })).toBe(false);
  });

});
