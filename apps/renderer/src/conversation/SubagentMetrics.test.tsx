import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { formatAgentCost, metricsFromUsage, resolveSubagentMetrics, SubagentMetrics } from "./SubagentMetrics";

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

  it("renders tok / tools / cost chips", () => {
    const { container } = render(
      <SubagentMetrics tokens="12.6k" tools={8} cost="¥ 0.51" />,
    );
    expect(container.querySelector(".sa-tok")?.textContent).toBe("12.6ktok");
    expect(container.querySelector(".hub-num")?.textContent).toBe("tools8");
    expect(container.querySelector(".sa-cost")?.textContent).toBe("¥ 0.51");
  });
});
