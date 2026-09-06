import { EVALUATION_LIMITS as L, type EvaluationOperation } from "./evaluation-protocol";

export class EvaluationValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvaluationValidationError";
	}
}

const KINDS = new Set<EvaluationOperation["kind"]>([
	"browser.evaluate",
	"computer.evaluate",
	"image.read",
	"terminal.image",
	"video.metadata",
	"video.frame",
	"eval.agent.start",
	"eval.agent.status",
	"eval.agent.wait",
	"eval.agent.cancel",
	"eval.completion.start",
	"eval.completion.status",
	"eval.completion.wait",
	"eval.completion.cancel",
	"eval.workpool.status",
]);
const SHAPES: Record<EvaluationOperation["kind"], readonly string[]> = {
	"browser.evaluate": ["kind", "expression", "target", "timeoutMs"],
	"computer.evaluate": ["kind", "action", "target", "timeoutMs"],
	"image.read": ["kind", "image", "question"],
	"terminal.image": ["kind", "result"],
	"video.metadata": ["kind", "attachmentId"],
	"video.frame": ["kind", "attachmentId", "timestampMs"],
	"eval.agent.start": ["kind", "definition", "assignment", "async"],
	"eval.agent.status": ["kind", "jobId", "expectedGeneration"],
	"eval.agent.wait": ["kind", "jobId", "expectedGeneration", "timeoutMs"],
	"eval.agent.cancel": ["kind", "jobId", "expectedGeneration"],
	"eval.completion.start": ["kind", "prompt", "model", "system", "schema"],
	"eval.completion.status": ["kind", "jobId", "expectedGeneration"],
	"eval.completion.wait": ["kind", "jobId", "expectedGeneration", "timeoutMs"],
	"eval.completion.cancel": ["kind", "jobId", "expectedGeneration"],
	"eval.workpool.status": ["kind", "name", "ownerAgentId"],
};
const fail = (message: string): never => {
	throw new EvaluationValidationError(message);
};
function obj(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
	return value as Record<string, unknown>;
}
function text(value: unknown, max: number, field: string): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > max || value.includes("\0"))
		fail(`${field} is invalid`);
	return value as string;
}
function integer(value: unknown, max: number, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max)
		fail(`${field} is invalid`);
	return value as number;
}
function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown evaluation field ${key}`);
}
function base64(value: unknown): void {
	const data = text(value, Math.ceil(L.IMAGE_MAX_BYTES / 3) * 4, "image data");
	if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
		fail("image data is not canonical Base64");
}
export function isEvaluationOperationKind(value: string): value is EvaluationOperation["kind"] {
	return KINDS.has(value as EvaluationOperation["kind"]);
}
export function validateEvaluationOperation(value: unknown): EvaluationOperation {
	const op = obj(value, "operation");
	if (typeof op.kind !== "string" || !isEvaluationOperationKind(op.kind)) fail("unknown evaluation operation");
	exact(op, SHAPES[op.kind as EvaluationOperation["kind"]]);
	if (op.timeoutMs !== undefined) integer(op.timeoutMs, L.TIMEOUT_MAX_MS, "timeoutMs");
	if (op.expectedGeneration !== undefined || (op.kind as string).endsWith(".cancel"))
		integer(op.expectedGeneration, Number.MAX_SAFE_INTEGER, "expectedGeneration");
	switch (op.kind) {
		case "browser.evaluate":
		case "computer.evaluate": {
			text(op.kind === "browser.evaluate" ? op.expression : op.action, L.TEXT_MAX_CHARS, "code");
			if (op.target !== undefined) {
				const target = obj(op.target, "target");
				exact(target, ["url", "tabId", "elementHandle"]);
				if (target.url !== undefined) {
					const url = text(target.url, L.PATH_MAX_CHARS, "target.url");
					let protocol = "";
					try {
						protocol = new URL(url).protocol;
					} catch {
						fail("target.url is invalid");
					}
					if (protocol !== "http:" && protocol !== "https:") fail("target.url is invalid");
				}
				for (const key of ["tabId", "elementHandle"])
					if (target[key] !== undefined) text(target[key], L.ID_MAX_CHARS, `target.${key}`);
			}
			break;
		}
		case "image.read":
			text(op.image, L.PATH_MAX_CHARS, "image");
			text(op.question, L.TEXT_MAX_CHARS, "question");
			break;
		case "terminal.image": {
			const result = obj(op.result, "result");
			exact(result, ["encoding", "data", "mimeType", "width", "height", "source"]);
			if (
				result.encoding !== "base64" ||
				!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(result.mimeType))
			)
				fail("terminal image format is invalid");
			if (result.source !== "kitty" && result.source !== "sixel") fail("terminal image source is invalid");
			base64(result.data);
			if (result.width !== undefined) integer(result.width, L.IMAGE_MAX_EDGE, "width");
			if (result.height !== undefined) integer(result.height, L.IMAGE_MAX_EDGE, "height");
			if (
				typeof result.width === "number" &&
				typeof result.height === "number" &&
				result.width * result.height > L.IMAGE_MAX_PIXELS
			)
				fail("terminal image dimensions are invalid");
			break;
		}
		case "video.metadata":
		case "video.frame":
			text(op.attachmentId, L.PATH_MAX_CHARS, "attachmentId");
			if (
				op.kind === "video.frame" &&
				(typeof op.timestampMs !== "number" || !Number.isFinite(op.timestampMs) || op.timestampMs < 0)
			)
				fail("timestampMs is invalid");
			break;
		case "eval.agent.start":
			text(op.definition, L.DEFINITION_MAX_CHARS, "definition");
			text(op.assignment, L.TEXT_MAX_CHARS, "assignment");
			if (op.async !== undefined && typeof op.async !== "boolean") fail("async is invalid");
			break;
		case "eval.completion.start":
			text(op.prompt, L.TEXT_MAX_CHARS, "prompt");
			if (op.system !== undefined) text(op.system, L.TEXT_MAX_CHARS, "system");
			if (op.model !== undefined && !["smol", "default", "slow"].includes(String(op.model)))
				fail("model is invalid");
			if (op.schema !== undefined) obj(op.schema, "schema");
			break;
		case "eval.workpool.status":
			text(op.name, L.DEFINITION_MAX_CHARS, "name");
			if (op.ownerAgentId !== undefined) text(op.ownerAgentId, L.ID_MAX_CHARS, "ownerAgentId");
			break;
		default:
			text(op.jobId, L.ID_MAX_CHARS, "jobId");
	}
	return op as unknown as EvaluationOperation;
}
