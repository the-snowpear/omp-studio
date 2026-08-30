import { describe, expect, it } from "vitest";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { applyLiveSubagentRoster, formatSubagentDuration, subagentDurationMs } from "./SubagentMetrics";
import type { SubagentView } from "./toolMeta";

const STARTED = "2026-08-29T08:57:15.000Z";
const STOPPED = "2026-08-29T09:05:15.000Z"; // 8m after STARTED
const LATER = Date.parse("2026-08-29T10:00:00.000Z");

function liveAgent(overrides: Partial<StudioAgentSnapshot> = {}): StudioAgentSnapshot {
  return {
    agentId: "NodeHelios",
    generation: 1,
    kind: "sub",
    displayName: "NodeHelios",
    status: "parked",
    startedAt: STARTED,
    updatedAt: STOPPED,
    hasLiveSession: false,
    hasTranscript: true,
    unreadCount: 0,
    activeJobIds: [],
    ...overrides,
  } as StudioAgentSnapshot;
}

function card(overrides: Partial<SubagentView> = {}): SubagentView {
  return { name: "NodeHelios", status: "running", toolCallId: "task-1", ...overrides };
}

describe("subagentDurationMs", () => {
  it("freezes a stopped agent at its last activity", () => {
    expect(subagentDurationMs(liveAgent(), LATER)).toBe(8 * 60_000);
    expect(subagentDurationMs(liveAgent({ status: "aborted" }), LATER)).toBe(8 * 60_000);
    expect(subagentDurationMs(liveAgent({ status: "failed" }), LATER)).toBe(8 * 60_000);
    expect(subagentDurationMs(liveAgent({ status: "idle" }), LATER)).toBe(8 * 60_000);
  });

  it("keeps counting while the agent is actually running", () => {
    expect(subagentDurationMs(liveAgent({ status: "running" }), LATER)).toBe(LATER - Date.parse(STARTED));
    expect(subagentDurationMs(liveAgent({ status: "starting" }), LATER)).toBe(LATER - Date.parse(STARTED));
    expect(subagentDurationMs(liveAgent({ status: "reviving" }), LATER)).toBe(LATER - Date.parse(STARTED));
  });

  it("prefers measured usage over any wall-clock estimate", () => {
    const usage = { tokens: 1, requests: 1, tools: 1, cost: 0, durationMs: 1234 };
    expect(subagentDurationMs(liveAgent({ status: "running", usage }), LATER)).toBe(1234);
  });

  it("reports nothing without a start time", () => {
    expect(subagentDurationMs({ status: "parked", updatedAt: STOPPED }, LATER)).toBeUndefined();
  });
});

describe("formatSubagentDuration", () => {
  it("switches to minutes and hours instead of four-digit seconds", () => {
    expect(formatSubagentDuration(3400)).toBe("3.4s");
    expect(formatSubagentDuration(8 * 60_000)).toBe("8m");
    expect(formatSubagentDuration(8 * 60_000 + 7000)).toBe("8m 7s");
    expect(formatSubagentDuration(3_900_000)).toBe("1h 5m");
  });
});

describe("applyLiveSubagentRoster", () => {
  it("stops the parked card clock at the frozen span", () => {
    const parked = liveAgent();
    const first = applyLiveSubagentRoster(card(), [parked], LATER);
    const second = applyLiveSubagentRoster(card(), [parked], LATER + 600_000);
    expect(first.dur).toBe("8m");
    expect(second.dur).toBe(first.dur);
    expect(first.status).toBe("parked");
  });

  it("still advances the clock for a running agent", () => {
    const running = liveAgent({ status: "running" });
    const first = applyLiveSubagentRoster(card(), [running], LATER);
    const second = applyLiveSubagentRoster(card(), [running], LATER + 600_000);
    expect(first.dur).not.toBe(second.dur);
  });

  it("shows the retained usage of a parked agent", () => {
    const parked = liveAgent({
      usage: { tokens: 12_600, requests: 9, tools: 14, cost: 0.51, durationMs: 480_000, durationKind: "span" },
    });
    const view = applyLiveSubagentRoster(card({ tokens: "0", requests: 0 }), [parked], LATER);
    expect(view).toMatchObject({ dur: "8m", tokens: "12.6k", requests: 9, tools: 14, cost: "$0.510" });
  });
});
