import { describe, expect, it } from "vitest";
import type { ClientInteraction } from "@omp-studio/client-contract";

import { THREAD_WAIT_LABEL, waitKindFromInteraction, waitKindFromLive } from "./threadWait";

function pending(kind: ClientInteraction["kind"], sessionId = "sess-a"): Pick<ClientInteraction, "sessionId" | "kind"> {
  return { sessionId: sessionId as ClientInteraction["sessionId"], kind };
}

describe("waitKindFromInteraction", () => {
  it("maps approval and confirm to 待确认", () => {
    expect(waitKindFromInteraction("approval")).toBe("approval");
    expect(waitKindFromInteraction("confirm")).toBe("approval");
    expect(THREAD_WAIT_LABEL.approval).toBe("待确认");
  });

  it("maps ask-style prompts to 待回答", () => {
    expect(waitKindFromInteraction("select")).toBe("ask");
    expect(waitKindFromInteraction("ask")).toBe("ask");
    expect(waitKindFromInteraction("input")).toBe("ask");
    expect(waitKindFromInteraction("editor")).toBe("ask");
    expect(THREAD_WAIT_LABEL.ask).toBe("待回答");
  });
});

describe("waitKindFromLive", () => {
  it("returns nothing without a session id", () => {
    expect(waitKindFromLive({ pending: pending("approval"), planStatus: "review" })).toBeUndefined();
  });

  it("prefers the pending interaction on that session", () => {
    expect(waitKindFromLive({
      sessionId: "sess-a",
      pending: pending("approval"),
      snapshotSessionId: "sess-a",
      planStatus: "review",
    })).toBe("approval");
    expect(waitKindFromLive({
      sessionId: "sess-a",
      pending: pending("select"),
    })).toBe("ask");
  });

  it("ignores a pending interaction that belongs to another session", () => {
    expect(waitKindFromLive({
      sessionId: "sess-b",
      pending: pending("approval", "sess-a"),
      snapshotSessionId: "sess-b",
      planStatus: "review",
    })).toBe("plan");
  });

  it("shows 待审核 when the live session is in plan review and nothing else is pending", () => {
    expect(waitKindFromLive({
      sessionId: "sess-a",
      snapshotSessionId: "sess-a",
      planStatus: "review",
    })).toBe("plan");
    expect(THREAD_WAIT_LABEL.plan).toBe("待审核");
  });

  it("does not treat an in-progress plan as waiting", () => {
    expect(waitKindFromLive({
      sessionId: "sess-a",
      snapshotSessionId: "sess-a",
      planStatus: "active",
    })).toBeUndefined();
  });
});
