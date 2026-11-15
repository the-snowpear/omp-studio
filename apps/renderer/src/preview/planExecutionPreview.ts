import type { NativePlanReview } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewPlanExecution(zh = isZh()): NativePlanReview {
  return {
    available: true, reviewId: "demo-plan-review", selectedRole: "default",
    tiers: [
      { role: "smol", provider: "anthropic", model: "claude-haiku-4.5", name: zh ? "快速实现" : "Quick iteration", thinkingLevel: "low" },
      { role: "default", provider: "anthropic", model: "claude-sonnet-4.5", name: zh ? "日常开发" : "Everyday dev", thinkingLevel: "high" },
      { role: "slow", provider: "anthropic", model: "claude-opus-4.1", name: zh ? "深入推理" : "Deep reasoning", thinkingLevel: "max" },
    ],
  };
}

export const PREVIEW_PLAN_EXECUTION: NativePlanReview = getPreviewPlanExecution();
