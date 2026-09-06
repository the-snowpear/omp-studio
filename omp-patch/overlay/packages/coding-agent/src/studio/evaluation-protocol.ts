type AgentId = string;
type Generation = number;
type JobId = string;

/** Bounded to fit the Bridge frame budget, including base64 expansion. */
export const EVALUATION_LIMITS = {
	TEXT_MAX_CHARS: 64 * 1024,
	PATH_MAX_CHARS: 4096,
	ID_MAX_CHARS: 512,
	DEFINITION_MAX_CHARS: 256,
	TIMEOUT_MAX_MS: 120_000,
	IMAGE_MAX_BYTES: 256 * 1024,
	IMAGE_MAX_EDGE: 8192,
	IMAGE_MAX_PIXELS: 16 * 1024 * 1024,
	SCHEMA_MAX_BYTES: 32 * 1024,
	SCHEMA_MAX_DEPTH: 16,
} as const;

export type EvaluationTarget = { url?: string; tabId?: string; elementHandle?: string };
export type EvaluationImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface EvaluationResult {
	value?: unknown;
	screenshotData?: string;
	mimeType?: EvaluationImageMime;
	title?: string;
}
export interface TerminalImageResult {
	encoding: "base64";
	data: string;
	mimeType: EvaluationImageMime;
	width?: number;
	height?: number;
	source: "kitty" | "sixel";
}
export interface VideoFrameResult {
	attachmentId: string;
	timestampMs: number;
	data: string;
	mimeType: EvaluationImageMime;
	width?: number;
	height?: number;
}

type EvalJobRead = { jobId: JobId; expectedGeneration?: Generation };
export type EvaluationOperation =
	| { kind: "browser.evaluate"; expression: string; target?: EvaluationTarget; timeoutMs?: number }
	| { kind: "computer.evaluate"; action: string; target?: EvaluationTarget; timeoutMs?: number }
	/** Runtime-readable path, including attachment:// references, rather than image bytes. */
	| { kind: "image.read"; image: string; question: string }
	| { kind: "terminal.image"; result: TerminalImageResult }
	| { kind: "video.metadata"; attachmentId: string }
	| { kind: "video.frame"; attachmentId: string; timestampMs: number }
	| { kind: "eval.agent.start"; definition: string; assignment: string; async?: boolean }
	| ({ kind: "eval.agent.status" } & EvalJobRead)
	| ({ kind: "eval.agent.wait"; timeoutMs?: number } & EvalJobRead)
	| { kind: "eval.agent.cancel"; jobId: JobId; expectedGeneration: Generation }
	| {
			kind: "eval.completion.start";
			prompt: string;
			model?: "smol" | "default" | "slow";
			system?: string;
			schema?: Record<string, unknown>;
	  }
	| ({ kind: "eval.completion.status" } & EvalJobRead)
	| ({ kind: "eval.completion.wait"; timeoutMs?: number } & EvalJobRead)
	| { kind: "eval.completion.cancel"; jobId: JobId; expectedGeneration: Generation }
	| { kind: "eval.workpool.status"; name: string; ownerAgentId?: AgentId };
