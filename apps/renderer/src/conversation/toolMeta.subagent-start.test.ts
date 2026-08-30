import { describe, expect, it } from "vitest";
import { collectAgents } from "./toolMeta";
import type { ToolView } from "./conversationViewModel";

describe("collectAgents at task start", () => {
  it("creates provisional cards from batch arguments before progress exists", () => {
    const tool: ToolView = {
      toolCallId: "task-1",
      toolName: "task",
      arguments: {
        context: "Inspect independently",
        tasks: [
          { name: "renderer", agent: "explorer", task: "Inspect renderer" },
          { name: "runtime", agent: "explorer", task: "Inspect runtime" },
        ],
      },
      status: "running",
    };

    expect(collectAgents([tool])).toEqual([
      { name: "renderer", status: "starting", toolCallId: "task-1", task: "Inspect renderer" },
      { name: "runtime", status: "starting", toolCallId: "task-1", task: "Inspect runtime" },
    ]);
  });

  it("creates a provisional card for the flat task form", () => {
    const tool: ToolView = {
      toolCallId: "task-2",
      toolName: "task",
      arguments: { agent: "explorer", task: "Inspect the renderer" },
      status: "running",
    };

    expect(collectAgents([tool])).toEqual([
      { name: "explorer", status: "starting", toolCallId: "task-2", task: "Inspect the renderer" },
    ]);
  });

  it("prefers real progress identities once the runtime reports them", () => {
    const tool: ToolView = {
      toolCallId: "task-3",
      toolName: "task",
      arguments: { name: "renderer", agent: "explorer", task: "Inspect the renderer" },
      result: {
        type: "toolResult",
        toolCallId: "task-3",
        isError: false,
        data: {
          progress: [{ id: "renderer-2", agent: "explorer", task: "Inspect the renderer", status: "running" }],
        },
      },
      status: "succeeded",
    };

    expect(collectAgents([tool])).toEqual([
      {
        name: "renderer-2",
        agentId: "renderer-2",
        status: "running",
        toolCallId: "task-3",
        task: "Inspect the renderer",
      },
    ]);
  });

  it("does not render the placeholder zeros of a not-yet-started async spawn", () => {
    const tool: ToolView = {
      toolCallId: "task-4",
      toolName: "task",
      arguments: { tasks: [{ name: "NodeValkyrie", agent: "task", task: "Inspect the runtime" }] },
      result: {
        type: "toolResult",
        toolCallId: "task-4",
        isError: false,
        data: {
          results: [],
          progress: [
            {
              index: 0,
              id: "NodeValkyrie",
              agent: "task",
              status: "pending",
              task: "Inspect the runtime",
              toolCount: 0,
              requests: 0,
              tokens: 0,
              cost: 0,
              durationMs: 0,
            },
          ],
        },
      },
      status: "running",
    };

    expect(collectAgents([tool])).toEqual([
      { name: "NodeValkyrie", agentId: "NodeValkyrie", status: "pending", toolCallId: "task-4", task: "Inspect the runtime" },
    ]);
  });

  it("reads the tool count a running progress row reports as toolCount", () => {
    const tool: ToolView = {
      toolCallId: "task-5",
      toolName: "task",
      arguments: { name: "NodeHelios", agent: "task", task: "Inspect the runtime" },
      result: {
        type: "toolResult",
        toolCallId: "task-5",
        isError: false,
        data: {
          progress: [
            {
              id: "NodeHelios",
              agent: "task",
              status: "running",
              task: "Inspect the runtime",
              toolCount: 14,
              requests: 9,
              tokens: 12_600,
              durationMs: 480_000,
            },
          ],
        },
      },
      status: "running",
    };

    expect(collectAgents([tool])).toEqual([
      {
        name: "NodeHelios",
        agentId: "NodeHelios",
        status: "running",
        toolCallId: "task-5",
        task: "Inspect the runtime",
        dur: "480.0s",
        tokens: "12600",
        tools: 14,
        requests: 9,
      },
    ]);
  });
});
