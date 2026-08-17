import { describe, expect, it } from "vitest";

import { threadRunningFromLive } from "./threadRunning";

describe("threadRunningFromLive", () => {
  it("returns false without a session id or snapshot session", () => {
    expect(threadRunningFromLive({ streaming: true, snapshotSessionId: "sess-a" })).toBe(false);
    expect(threadRunningFromLive({ sessionId: "sess-a", streaming: true })).toBe(false);
  });

  it("returns true only for the resident session that is streaming or compacting", () => {
    expect(threadRunningFromLive({
      sessionId: "sess-a",
      snapshotSessionId: "sess-a",
      streaming: true,
    })).toBe(true);
    expect(threadRunningFromLive({
      sessionId: "sess-a",
      snapshotSessionId: "sess-a",
      compacting: true,
    })).toBe(true);
    expect(threadRunningFromLive({
      sessionId: "sess-b",
      snapshotSessionId: "sess-a",
      streaming: true,
    })).toBe(false);
  });

  it("does not treat an idle resident session as running", () => {
    expect(threadRunningFromLive({
      sessionId: "sess-a",
      snapshotSessionId: "sess-a",
    })).toBe(false);
  });
});
