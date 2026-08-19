import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import type { AgentId, Generation, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import {
  applyLiveSubagentRoster,
  formatAgentCost,
  formatSubagentDuration,
  metricsFromUsage,
  resolveSubagentMetrics,
  SubagentMetrics,
} from "./SubagentMetrics";
import type { SubagentView } from "./toolMeta";

const LIVE: StudioAgentSnapshot = {
  agentId: "WorkerAlpha" as AgentId,
  generation: 1 as Generation,
  kind: "task",
  displayName: "WorkerAlpha",
  status: "running",
  assignment: "scan lockfile",
  updatedAt: "2026-08-19T00:00:00.000Z",
  startedAt: "2026-08-19T00:00:00.000Z",
  hasLiveSession: true,
  hasTranscript: true,
  unreadCount: 0,
  activeJobIds: [],
  usage: { tokens: 12_600, requests: 9, tools: 14, cost: 0.51, durationMs: 38_000 },
};

const PLACEHOLDER: SubagentView = {
  name: "WorkerAlpha",
  status: "pending",
  toolCallId: "task-1",
  agentId: "WorkerAlpha",
  tokens: "[redacted]",
  requests: 0,
  dur: "0.0s",
};

afterEach(cleanup);

describe("subagent metrics", () => {
  it("formats host usage like the compact card fields", () => {
    expect(formatAgentCost(0.51)).toBe("$0.510");
    expect(metricsFromUsage({
      tokens: 12_600,
      requests: 9,
      tools: 14,
      cost: 0.51,
      durationMs: 167_000,
    })).toEqual({
      tokens: "12.6k",
      tools: 14,
      requests: 9,
      cost: "$0.510",
    });
  });

  it("lets live usage override card-click strings and keeps files from the card", () => {
    expect(resolveSubagentMetrics(
      { tokens: 5100, requests: 2, tools: 3, cost: 0.18, durationMs: 9000 },
      { tokens: "12.6k", tools: 8, cost: "¥ 0.51", files: 6 },
    )).toEqual({
      tokens: "5.1k",
      tools: 3,
      requests: 2,
      files: 6,
      cost: "$0.180",
    });
  });

  it("drops [redacted] card strings so live usage can fill the gap", () => {
    expect(resolveSubagentMetrics(
      { tokens: 12_600, requests: 9, tools: 14, cost: 0.51, durationMs: 38_000 },
      { tokens: "[redacted]", requests: 0 },
    )).toEqual({
      tokens: "12.6k",
      tools: 14,
      requests: 9,
      cost: "$0.510",
    });
    expect(resolveSubagentMetrics(undefined, { tokens: "[redacted]", cost: "[redacted]" })).toEqual({});
  });

  it("overlays Hub roster status, duration, and usage onto a spawn placeholder card", () => {
    expect(formatSubagentDuration(38_000)).toBe("38.0s");
    const overlay = applyLiveSubagentRoster(PLACEHOLDER, [LIVE]);
    expect(overlay).toMatchObject({
      name: "WorkerAlpha",
      agentId: "WorkerAlpha",
      status: "running",
      task: "scan lockfile",
      dur: "38.0s",
      tokens: "12.6k",
      tools: 14,
      requests: 9,
      cost: "$0.510",
    });
  });

  it("matches a name-only card to a unique Hub displayName", () => {
    const overlay = applyLiveSubagentRoster(
      { name: "WorkerAlpha", status: "pending", toolCallId: "task-1", tokens: "[redacted]" },
      [LIVE],
    );
    expect(overlay.agentId).toBe("WorkerAlpha");
    expect(overlay.tokens).toBe("12.6k");
    expect(overlay.status).toBe("running");
  });

  it("strips [redacted] even when the matched Hub agent has no usage yet", () => {
    const { usage: _unusedUsage, ...starting } = LIVE;
    const overlay = applyLiveSubagentRoster(PLACEHOLDER, [{ ...starting, status: "starting" }]);
    expect(overlay.status).toBe("starting");
    expect(overlay.tokens).toBeUndefined();
    expect(overlay.cost).toBeUndefined();
    expect(overlay.requests).toBe(0);
  });

  it("does not steal metrics when two roster agents share a display name", () => {
    const overlay = applyLiveSubagentRoster(
      { name: "Worker", status: "pending", toolCallId: "task-1" },
      [
        { ...LIVE, agentId: "Worker-1" as AgentId, displayName: "Worker" },
        { ...LIVE, agentId: "Worker-2" as AgentId, displayName: "Worker", usage: { tokens: 99, requests: 1, tools: 1, cost: 0.01, durationMs: 1000 } },
      ],
    );
    expect(overlay).toEqual({ name: "Worker", status: "pending", toolCallId: "task-1" });
  });

  it("renders tok / tools / cost chips", () => {
    const { container } = render(
      <SubagentMetrics tokens="12.6k" tools={8} cost="¥ 0.51" />,
    );
    expect(container.querySelector(".sa-tok")?.textContent).toBe("12.6ktok");
    expect(container.querySelector(".hub-num")?.textContent).toBe("tools8");
    expect(container.querySelector(".sa-cost")?.textContent).toBe("¥ 0.51");
  });
});
