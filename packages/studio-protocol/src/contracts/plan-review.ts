export interface PlanExecutionTier { role: string; provider: string; model: string; name: string; thinkingLevel?: string }
export interface NativePlanReview { available: boolean; reviewId?: string; tiers: PlanExecutionTier[]; selectedRole?: string }
export type NativePlanDecision = "execute" | "compact" | "keep" | "refine" | "dismiss";
export type NativePlanReviewOperation =
  | { kind: "mode.plan.review.details"; sessionId: string }
  | { kind: "mode.plan.review.resolve"; sessionId: string; reviewId: string; decision: NativePlanDecision; role?: string; feedback?: string };
export interface NativePlanReviewResultMap { "mode.plan.review.details": NativePlanReview; "mode.plan.review.resolve": { resolved: true } }
export const NATIVE_PLAN_REVIEW_KINDS = ["mode.plan.review.details", "mode.plan.review.resolve"] as const;
export function isNativePlanReviewKind(kind: string): kind is NativePlanReviewOperation["kind"] { return (NATIVE_PLAN_REVIEW_KINDS as readonly string[]).includes(kind); }
