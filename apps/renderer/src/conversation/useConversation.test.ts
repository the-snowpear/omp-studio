import { describe, expect, it } from "vitest";
import type { SessionId } from "@omp-studio/client-contract";
import type { ConversationSnapshot } from "./conversationEngine";
import { resetConversation, type HydrateStatus } from "./conversationViewModel";
import { retainConversationWhileRemounting } from "./useConversation";

const sessionA = "session-a" as SessionId;
const sessionB = "session-b" as SessionId;

function snapshot(sessionId: SessionId | undefined, rows: ConversationSnapshot["rows"], hydrateStatus: HydrateStatus = rows.length === 0 ? "idle" : "ready"): ConversationSnapshot {
  return {
    state: resetConversation(1, sessionId === undefined ? null : { sessionId }, hydrateStatus),
    rows,
    demo: false,
    loadingOlder: false,
    identityKey: sessionId ?? "",
  };
}

describe("retainConversationWhileRemounting", () => {
  it("keeps the previous transcript while the remounted engine is still empty for the same session", () => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const remounting = snapshot(undefined, [], "loading");
    expect(retainConversationWhileRemounting(remounting, previous, sessionA)).toBe(previous);
  });

  it("does not paint another session's transcript over an empty remount", () => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const remounting = snapshot(undefined, []);
    expect(retainConversationWhileRemounting(remounting, previous, sessionB)).toBe(remounting);
  });

  it("lets a hydrated current snapshot replace the hold", () => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const current = snapshot(sessionA, [{ type: "compaction", item: {
      kind: "compaction",
      itemId: "cp-1",
      parentId: null,
      createdAt: "t",
      summary: "Summarized.",
      shortSummary: "Done",
    } }]);
    expect(retainConversationWhileRemounting(current, previous, sessionA)).toBe(current);
  });

  it.each(["ready", "error", "unavailable"] as const)("releases the previous transcript when an empty remount reaches %s", (hydrateStatus) => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const current = snapshot(sessionA, [], hydrateStatus);
    expect(retainConversationWhileRemounting(current, previous, sessionA)).toBe(current);
  });
});
