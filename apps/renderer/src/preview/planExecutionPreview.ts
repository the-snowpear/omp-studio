import type { NativePlanReview } from "@omp-studio/studio-protocol";
export const PREVIEW_PLAN_EXECUTION: NativePlanReview = {
  available: true, reviewId: "demo-plan-review", selectedRole: "default",
  tiers: [
    { role: "smol", provider: "anthropic", model: "claude-haiku-4.5", name: "快速实现", thinkingLevel: "low" },
    { role: "default", provider: "anthropic", model: "claude-sonnet-4.5", name: "日常开发", thinkingLevel: "high" },
    { role: "slow", provider: "anthropic", model: "claude-opus-4.1", name: "深入推理", thinkingLevel: "max" },
  ],
};
