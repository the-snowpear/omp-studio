import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BatchChain } from "./BatchChain";
import type { ToolView } from "./conversationViewModel";

describe("BatchChain subagent start", () => {
  it("renders a starting subagent card from task arguments", () => {
    const tool: ToolView = {
      toolCallId: "task-1",
      toolName: "task",
      arguments: { name: "renderer", agent: "explorer", task: "Inspect renderer" },
      status: "running",
    };

    const { container } = render(
      <BatchChain items={[{ kind: "tool", tool }]} batchKey="task-chain" liveTail />,
    );

    expect(container.querySelector(".subagent-strip .sa-card")?.textContent).toContain("renderer");
    expect(container.querySelector(".subagent-strip .hub-act")?.textContent).toBe("Starting");
  });
});
