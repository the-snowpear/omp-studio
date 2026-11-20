export interface PlanExecutionTier {
	role: string;
	provider: string;
	model: string;
	name: string;
	thinkingLevel?: string;
	contextWindow?: number;
}
export type NativePlanDecision = "execute" | "compact" | "keep" | "refine" | "save" | "dismiss";
export interface NativePlanOption {
	kind: Exclude<NativePlanDecision, "dismiss">;
	label: string;
	disabled?: boolean;
	description?: string;
}
export interface NativePlanReview {
	available: boolean;
	reviewId?: string;
	tiers: PlanExecutionTier[];
	selectedRole?: string;
	options?: NativePlanOption[];
	contextRatio?: number;
}
export type NativePlanReviewOperation =
	| { kind: "mode.plan.review.details"; sessionId: string; role?: string }
	| { kind: "mode.plan.review.save"; sessionId: string; reviewId: string; markdown: string }
	| {
			kind: "mode.plan.review.resolve";
			sessionId: string;
			reviewId: string;
			decision: NativePlanDecision;
			role?: string;
			feedback?: string;
	  };
export interface NativePlanReviewResultMap {
	"mode.plan.review.details": NativePlanReview;
	"mode.plan.review.save": { saved: true };
	"mode.plan.review.resolve": { resolved: true };
}
export const NATIVE_PLAN_REVIEW_KINDS = [
	"mode.plan.review.details",
	"mode.plan.review.save",
	"mode.plan.review.resolve",
] as const;
export function isNativePlanReviewKind(kind: string): kind is NativePlanReviewOperation["kind"] {
	return (NATIVE_PLAN_REVIEW_KINDS as readonly string[]).includes(kind);
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid plan review data");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024): void {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw Error("Invalid plan review text");
}
export function validateNativePlanReviewOperation(value: unknown): void {
	const row = object(value);
	text(row.sessionId, 128);
	if (row.kind === "mode.plan.review.details") {
		if (row.role !== undefined) text(row.role, 128);
		return;
	}
	if (row.kind === "mode.plan.review.save") {
		text(row.reviewId, 128);
		text(row.markdown, 262144);
		return;
	}
	if (
		row.kind !== "mode.plan.review.resolve" ||
		!["execute", "compact", "keep", "refine", "save", "dismiss"].includes(row.decision as string)
	)
		throw Error("Unknown plan decision");
	text(row.reviewId, 128);
	if (row.role !== undefined) {
		text(row.role, 128);
		if (row.decision === "refine" || row.decision === "dismiss" || row.decision === "save")
			throw Error("Execution role requires an approval");
	}
	if (row.feedback !== undefined) text(row.feedback, 65536);
	if (row.decision === "refine") text(row.feedback, 65536);
}
