import { expect, it, vi } from "vitest";
import { ConversationViewLeases } from "./conversationViews";

it("StrictMode leases aggregate child IDs, release idempotently and do not publish stale epochs", async () => {
  const report = vi.fn(); const leases = new ConversationViewLeases(report);
  leases.setEpoch(1);
  const release1 = leases.acquire(1, "child-session");
  release1(); release1();
  const release2 = leases.acquire(1, "child-session");
  const release3 = leases.acquire(1, "child-session");
  await Promise.resolve();
  expect(report).toHaveBeenLastCalledWith({ runtimeEpoch: 1, visibleSessionIds: ["child-session"] });
  release2(); await Promise.resolve(); expect(report.mock.lastCall?.[0].visibleSessionIds).toEqual(["child-session"]);
  leases.setEpoch(2); await Promise.resolve(); expect(report).toHaveBeenLastCalledWith({ runtimeEpoch: 2, visibleSessionIds: [] });
  const release4 = leases.acquire(2, "new-session");
  release3(); await Promise.resolve(); expect(report.mock.lastCall?.[0].visibleSessionIds).toEqual(["new-session"]);
  release4(); await Promise.resolve(); expect(report.mock.lastCall?.[0].visibleSessionIds).toEqual([]);
});
