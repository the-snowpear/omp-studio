import type { NativePlanReview } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewPlanExecution(_zh = isZh()): NativePlanReview {
  return {
    available: true, reviewId: "demo-plan-review", selectedRole: "default",
    tiers: [
      { role: "smol", provider: "anthropic", model: "claude-haiku-4.5", name: "Claude Haiku 4.5", thinkingLevel: "low" },
      { role: "default", provider: "anthropic", model: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", thinkingLevel: "high" },
      { role: "slow", provider: "anthropic", model: "claude-opus-4.8", name: "Claude Opus 4.8", thinkingLevel: "max" },
    ],
  };
}

export const PREVIEW_PLAN_EXECUTION: NativePlanReview = getPreviewPlanExecution();
