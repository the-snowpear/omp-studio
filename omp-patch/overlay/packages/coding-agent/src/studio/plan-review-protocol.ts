export interface PlanExecutionTier {
	role: string;
	provider: string;
	model: string;
	name: string;
	thinkingLevel?: string;
}
export interface NativePlanReview {
	available: boolean;
	reviewId?: string;
	tiers: PlanExecutionTier[];
	selectedRole?: string;
}
export type NativePlanDecision = "execute" | "compact" | "keep" | "refine" | "dismiss";
export type NativePlanReviewOperation =
	| { kind: "mode.plan.review.details"; sessionId: string }
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
	"mode.plan.review.resolve": { resolved: true };
}
export const NATIVE_PLAN_REVIEW_KINDS = ["mode.plan.review.details", "mode.plan.review.resolve"] as const;
export function isNativePlanReviewKind(kind: string): kind is NativePlanReviewOperation["kind"] {
	return (NATIVE_PLAN_REVIEW_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw Error("Invalid plan review data");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024): void {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw Error("Invalid plan review text");
}
export function validateNativePlanReviewOperation(value: unknown): void {
	const row = object(value, ["kind", "sessionId", "reviewId", "decision", "role", "feedback"]);
	text(row.sessionId, 128);
	if (row.kind === "mode.plan.review.details") {
		object(value, ["kind", "sessionId"]);
		return;
	}
	if (
		row.kind !== "mode.plan.review.resolve" ||
		!["execute", "compact", "keep", "refine", "dismiss"].includes(row.decision as string)
	)
		throw Error("Unknown plan decision");
	text(row.reviewId, 128);
	if (row.role !== undefined) {
		text(row.role, 128);
		if (row.decision === "refine" || row.decision === "dismiss") throw Error("Execution role requires an approval");
	}
	if (row.feedback !== undefined) text(row.feedback, 65536);
	if (row.decision === "refine") text(row.feedback, 65536);
}
export function validateNativePlanReviewResult(kind: NativePlanReviewOperation["kind"], value: unknown): void {
	if (kind === "mode.plan.review.resolve") {
		if (object(value, ["resolved"]).resolved !== true) throw Error("Invalid plan resolution");
		return;
	}
	const row = object(value, ["available", "reviewId", "tiers", "selectedRole"]);
	if (typeof row.available !== "boolean" || !Array.isArray(row.tiers) || row.tiers.length > 32)
		throw Error("Invalid review availability");
	if (row.available || row.reviewId !== undefined) text(row.reviewId, 128);
	if (row.selectedRole !== undefined) text(row.selectedRole, 128);
	for (const item of row.tiers) {
		const tier = object(item, ["role", "provider", "model", "name", "thinkingLevel"]);
		for (const key of ["role", "provider", "model", "name"]) text(tier[key]);
		if (tier.thinkingLevel !== undefined) text(tier.thinkingLevel, 64);
	}
}
