import type { AgentBtwState } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewChildBtwTurns(zh = isZh()): AgentBtwState["turns"] {
  return [{
    question: zh ? "这个子任务的测试范围是什么？" : "What is the test scope for this subtask?",
    answer: zh ? "先检查当前子任务修改的模块，再运行对应回归测试。" : "Inspect the modules modified by this subtask first, then run the matching regression tests.",
    status: "complete",
    createdAt: 1790726400000,
    updatedAt: 1790726400000,
  }];
}

export const PREVIEW_CHILD_BTW_TURNS: AgentBtwState["turns"] = getPreviewChildBtwTurns();

export function agentBtwPreview(agentId: string, zh = isZh()): AgentBtwState {
  return {
    binding: "demo-child-btw",
    agentId,
    targetSessionId: "demo-child-session",
    snapshot: null,
    topics: [{
      topicId: "demo-child-topic",
      question: zh ? "这个子任务的测试范围是什么？" : "What is the test scope for this subtask?",
      status: "complete",
      updatedAt: 1790726400000,
      turnCount: 1,
    }],
    turns: [],
  };
}
