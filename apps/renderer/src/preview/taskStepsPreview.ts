import type { StudioTaskStepState } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

/** The existing ver1 Agent Hub stories, shown as native prompt groups only in preview mode. */
function buildTaskStepFixtures(zh: boolean): Readonly<Record<string, StudioTaskStepState>> {
  return {
    "agent-019fcb01": {
      prompts: zh
        ? [
            "先扫 package-lock.json 定位间接依赖；审计 @earendil-works/pi-* 0.82.1 的变化。",
            "对 pi-mermaid 做类型 diff，确认 Mermaid 类型签名。",
            "验证调用方与升级后的签名兼容，归类需要调整的用法。",
            "汇报依赖审计结果、已验证部分和剩余风险。",
          ]
        : [
            "Scan package-lock.json to locate transitive dependencies; audit @earendil-works/pi-* 0.82.1 changes.",
            "Diff pi-mermaid types to confirm Mermaid type signatures.",
            "Verify callers are compatible with upgraded signatures and classify call sites needing updates.",
            "Report dependency audit findings, verified areas, and remaining risks.",
          ],
      sent: 2, completed: 1, phase: "running",
    },
    "agent-019fcb20": {
      prompts: zh
        ? ["运行完整类型检查并记录实际错误。", "按 renderer / protocol / host 归类错误，定位需要调整的接口。", "复查结果并汇报实际通过项。"]
        : ["Run a full typecheck and record actual errors.", "Categorize errors across renderer / protocol / host and locate interfaces to update.", "Re-verify results and report passing checks."],
      sent: 2, completed: 1, phase: "running",
    },
    "agent-019fc9d2": {
      prompts: zh
        ? ["核对上游同步的三个阶段和既有验证记录。", "整理 UPSTREAM-SYNC.md 三阶段章节草稿。", "复核草稿 v2，交付需要人工确认的部分。"]
        : ["Review the three upstream sync phases and existing verification logs.", "Draft the three-phase UPSTREAM-SYNC.md sections.", "Review draft v2 and hand off items needing manual confirmation."],
      sent: 3, completed: 3, phase: "completed",
    },
    "agent-019fcb55": {
      prompts: zh
        ? ["运行 merge 后 ESLint 回归。", "归类真实扫描结果。", "汇报回归结果。"]
        : ["Run post-merge ESLint regression checks.", "Classify actual scan results.", "Report regression results."],
      sent: 1, completed: 0, phase: "failed",
      reason: zh ? "ESLint exited with code 2 · .eslintrc 合并冲突" : "ESLint exited with code 2 · .eslintrc merge conflict",
    },
    "agent-019fc77e": {
      prompts: zh
        ? ["确认 ws 通道替代 stdio 的边界。", "验证最小通信链。", "汇报可行性与风险。"]
        : ["Confirm boundaries for replacing stdio with the WebSocket channel.", "Verify minimal communication chain.", "Report feasibility and risks."],
      sent: 1, completed: 0, phase: "interrupted",
      reason: zh ? "方案被否决后由用户停止。" : "Stopped by user after proposal was rejected.",
    },
  };
}

export function previewTaskStepsForAgent(agentId: string, zh = isZh()): StudioTaskStepState | undefined {
  return buildTaskStepFixtures(zh)[agentId];
}
