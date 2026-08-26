/**
 * 手工基准：一次流式提交在派生层的真实开销。
 *
 * 不是门禁测试（不断言阈值，机器差异太大），只把「一次 45ms 提交要做多少工作」量出来，
 * 供重构前后对比。运行：
 *   npx vitest run src/conversation/perfbench.manual.test.ts --reporter=verbose
 */

import { describe, it } from "vitest";
import { selectConversationViews, type ConversationState as ClientConversationState } from "@omp-studio/client";
import type { ConversationItem } from "@omp-studio/client-contract";
import { ConversationRowsProjector, type TimelineRow } from "./conversationViewModel";
import { reuseTimelineRows } from "./rowReuse";
import { sessionTaskProgress, collectLatestPlanDocument } from "./toolMeta";
import { projectAgentTestRuns } from "./agentTestRuns";
import { timelineRowsSignature } from "./sessionConversationCache";

const PARAGRAPH = "这是一段用于基准测试的助手回复文本，长度接近真实回复的一个段落。".repeat(4);

function assistantItem(index: number, toolCount: number): ConversationItem {
  const content: unknown[] = [{ type: "text", text: `${PARAGRAPH}\n\n第 ${index} 段。` }];
  for (let tool = 0; tool < toolCount; tool += 1) {
    content.push({
      type: "toolCall",
      toolCallId: `call-${index}-${tool}`,
      toolName: tool % 2 === 0 ? "Read" : "Bash",
      arguments: { path: `src/module-${index}-${tool}.ts`, command: "npm test" },
    });
    content.push({
      type: "toolResult",
      toolCallId: `call-${index}-${tool}`,
      output: "输出行\n".repeat(40),
    });
  }
  return {
    itemId: `item-${index}`,
    kind: "message",
    role: "assistant",
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    turnId: `turn-${Math.floor(index / 2)}`,
    content,
  } as unknown as ConversationItem;
}

function userItem(index: number): ConversationItem {
  return {
    itemId: `item-${index}`,
    kind: "message",
    role: "user",
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    turnId: `turn-${Math.floor(index / 2)}`,
    content: [{ type: "text", text: `用户请求 ${index}` }],
  } as unknown as ConversationItem;
}

function buildState(itemCount: number, toolsPerAssistant: number): ClientConversationState {
  const itemsById: Record<string, ConversationItem> = {};
  const order: string[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    const item = index % 2 === 0 ? userItem(index) : assistantItem(index, toolsPerAssistant);
    itemsById[item.itemId] = item;
    order.push(item.itemId);
  }
  return {
    itemsById,
    order,
    liveMessages: {},
    liveTools: {},
    notices: [],
    hasMoreBefore: false,
    hydrateStatus: "ready",
    hydrateGeneration: 1,
    resyncRequired: false,
    abortedTurns: {},
    itemErrors: {},
    stickyProviderErrors: {},
    openTurnItems: {},
  } as unknown as ClientConversationState;
}

/** 在末尾挂一条正在流式的 live 消息，模拟「只有最后一条在长」。*/
function withStreamingTail(base: ClientConversationState, text: string): ClientConversationState {
  const messageId = "live-tail";
  return {
    ...base,
    order: [...base.order, messageId],
    liveMessages: {
      [messageId]: {
        messageId,
        turnId: "turn-live",
        role: "assistant",
        createdAt: "2026-01-01T00:00:00.000Z",
        blocks: { b1: { blockId: "b1", blockType: "text", text, textBytes: text.length } },
        completed: false,
        aborted: false,
      },
    },
  } as unknown as ClientConversationState;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function bench(label: string, iterations: number, run: (tick: number) => void): void {
  run(0); // warm up JIT + fill caches
  const samples: number[] = [];
  for (let tick = 1; tick <= iterations; tick += 1) {
    const start = performance.now();
    run(tick);
    samples.push(performance.now() - start);
  }
  const total = samples.reduce((sum, value) => sum + value, 0);
  console.log(
    `${label.padEnd(46)} median ${median(samples).toFixed(3)}ms  mean ${(total / samples.length).toFixed(3)}ms  max ${Math.max(...samples).toFixed(3)}ms`,
  );
}

describe("conversation derive cost per streaming commit", () => {
  it("measures one commit of a streaming text delta", () => {
    for (const itemCount of [60, 200, 400]) {
      const toolsPerAssistant = 3;
      const base = buildState(itemCount, toolsPerAssistant);
      console.log(`\n--- ${itemCount} persisted items, ${toolsPerAssistant} tools per assistant row ---`);

      const projector = new ConversationRowsProjector();
      let text = "";
      let rows: readonly TimelineRow[] = [];

      bench("selectConversationViews + project + reuse", 60, (tick) => {
        text += `增量分片 ${tick} `;
        const state = withStreamingTail(base, text);
        const views = selectConversationViews(state);
        const projected = projector.project(views, [], {}, {}, {});
        // conversationEngine.readSnapshot 在 project 之后又跑一遍 reuseTimelineRows
        rows = reuseTimelineRows(rows, projected);
      });

      const stableRows = rows;
      bench("WorkbenchCanvas rows-derived useMemos", 60, () => {
        sessionTaskProgress(stableRows);
        projectAgentTestRuns(stableRows);
        collectLatestPlanDocument(stableRows);
      });
      bench("timelineRowsSignature (ConvoTranscript)", 60, () => {
        timelineRowsSignature(stableRows);
      });
    }
  });
});
