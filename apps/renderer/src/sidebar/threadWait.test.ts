import { expect, it } from "vitest";
import type { ResidentSessionRow } from "@omp-studio/client-contract";
import { waitKindFromLive } from "./threadWait";

it("clears a stale persisted approval badge as soon as the live resident becomes idle", () => {
  const resident = { sessionId: "s", phase: "idle" } as ResidentSessionRow;
  expect(waitKindFromLive({ sessionId: "s", resident, persistedWaitingForApproval: true })).toBeUndefined();
  expect(waitKindFromLive({ sessionId: "s", snapshotSessionId: "s", snapshotWaitingForApproval: false, persistedWaitingForApproval: true })).toBeUndefined();
  expect(waitKindFromLive({ sessionId: "cold", residents: [resident], persistedWaitingForApproval: true })).toBe("approval");
});

it("uses current approval and plan waits ahead of the persisted directory state", () => {
  expect(waitKindFromLive({ sessionId: "s", snapshotSessionId: "s", snapshotWaitingForApproval: true })).toBe("approval");
  expect(waitKindFromLive({ sessionId: "s", snapshotSessionId: "s", planStatus: "review", persistedWaitingForApproval: true })).toBe("plan");
});
