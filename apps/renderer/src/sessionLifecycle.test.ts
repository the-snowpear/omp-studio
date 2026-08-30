import { describe, expect, it, vi } from "vitest";
import type { SessionId, StudioClient, ThreadId } from "@omp-studio/client-contract";
import { ensureSelectedSessionActive } from "./sessionLifecycle";

function completedResumeClient(sessionId: SessionId) {
  const command = vi.fn(async () => ({ requestId: "resume-request" }));
  const client = {
    command,
    subscribe: () => () => {},
    getState: () => ({
      commands: {
        "resume-request": {
          requestId: "resume-request",
          name: "session.resume",
          status: "completed",
          result: { sessionId },
        },
      },
    }),
  } as unknown as StudioClient;
  return { client, command };
}

describe("ensureSelectedSessionActive", () => {
  it("resumes a loaded historical conversation before a write action", async () => {
    const selectedSessionId = "historical-session" as SessionId;
    const selectedThreadId = "historical-thread" as ThreadId;
    const { client, command } = completedResumeClient(selectedSessionId);

    await ensureSelectedSessionActive(client, {
      activeSessionId: "other-session" as SessionId,
      selectedSessionId,
      selectedThreadId,
    });

    expect(command).toHaveBeenCalledWith("session.resume", { threadId: selectedThreadId });
  });

  it("does not resume when the viewed session is already active", async () => {
    const selectedSessionId = "active-session" as SessionId;
    const { client, command } = completedResumeClient(selectedSessionId);

    await ensureSelectedSessionActive(client, {
      activeSessionId: selectedSessionId,
      selectedSessionId,
      selectedThreadId: "active-thread" as ThreadId,
    });

    expect(command).not.toHaveBeenCalled();
  });
});
