import type { NativePlanReview } from "@omp-studio/studio-protocol";
export const PREVIEW_PLAN_EXECUTION: NativePlanReview = {
  available: true, reviewId: "demo-plan-review", selectedRole: "default",
  tiers: [
    { role: "smol", provider: "demo", model: "quick", name: "快速实现", thinkingLevel: "low" },
    { role: "default", provider: "demo", model: "balanced", name: "日常开发", thinkingLevel: "high" },
    { role: "slow", provider: "demo", model: "deep", name: "深入推理", thinkingLevel: "max" },
  ],
};
