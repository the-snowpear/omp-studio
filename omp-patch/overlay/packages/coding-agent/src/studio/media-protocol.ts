export type MediaKind = "image" | "video" | "transcription" | "speech";
export type MediaRequest =
	| {
			type: "image";
			model?: string;
			prompt: string;
			inputArtifacts?: string[];
			aspectRatio?: string;
			imageSize?: string;
			count?: number;
	  }
	| {
			type: "video";
			model: string;
			prompt?: string;
			duration?: number;
			resolution?: string;
			aspectRatio?: string;
			size?: string;
			firstFrame?: string;
			lastFrame?: string;
			references?: Array<{ artifactId: string; type: "image" | "audio" | "video" }>;
			generateAudio?: boolean;
			seed?: number;
			creativity?: number;
			upscaleFactor?: number;
			providerOptions?: Record<string, unknown>;
	  }
	| {
			type: "transcription";
			model?: string;
			audioArtifact: string;
			language?: string;
			prompt?: string;
			timestamps?: "none" | "segment" | "word";
			temperature?: number;
	  }
	| {
			type: "speech";
			model?: string;
			text: string;
			voice?: string;
			format: "mp3" | "wav" | "pcm" | "opus" | "aac" | "flac";
			speed?: number;
			sampleRate?: number;
			bitRate?: number;
			instructions?: string;
	  };
export interface MediaModelChoice {
	selector: string;
	name: string;
	kind: MediaKind;
	api: string;
	local: boolean;
	parameters: string[];
	formats?: string[];
	voices?: Array<{ id: string; label: string }>;
}
export interface MediaJob {
	id: string;
	sessionId: string;
	type: MediaKind;
	state: "queued" | "running" | "waiting" | "paused" | "completed" | "cancelled" | "failed" | "interrupted";
	createdAt: number;
	updatedAt: number;
	model?: string;
	cost?: number;
	error?: string;
	canResume: boolean;
	outputCount: number;
}
export interface MediaOutput {
	artifactId: string;
	kind: "image" | "audio" | "video" | "transcript";
	name: string;
	mimeType: string;
	bytes: number;
	sha256: string;
}
export interface MediaDetail {
	job: MediaJob;
	request: MediaRequest;
	outputs: MediaOutput[];
	text?: string;
	textTruncated?: boolean;
}
export type MediaOperation =
	| { kind: "media.models"; sessionId: string; cursor?: string }
	| { kind: "media.list"; sessionId: string }
	| {
			kind: "media.start";
			sessionId: string;
			request: MediaRequest;
			/** Main-only input grants; rejected at public IPC. */ inputTransfers?: Array<{
				artifactId: string;
				transferId: string;
			}>;
	  }
	| { kind: "media.read"; sessionId: string; id: string }
	| { kind: "media.cancel"; sessionId: string; id: string }
	| { kind: "media.resume"; sessionId: string; id: string }
	| { kind: "media.close"; sessionId: string; id: string };
export interface MediaResultMap {
	"media.models": { available: boolean; models: MediaModelChoice[]; nextCursor?: string };
	"media.list": { available: boolean; jobs: MediaJob[] };
	"media.start": { job: MediaJob };
	"media.read": MediaDetail;
	"media.cancel": { job: MediaJob };
	"media.resume": { job: MediaJob };
	"media.close": { closed: boolean };
}
export const MEDIA_OPERATION_KINDS = [
	"media.models",
	"media.list",
	"media.start",
	"media.read",
	"media.cancel",
	"media.resume",
	"media.close",
] as const;
export function isMediaOperationKind(kind: string): kind is MediaOperation["kind"] {
	return (MEDIA_OPERATION_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a media object");
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).some(
			key => ["__proto__", "prototype", "constructor"].includes(key) || (keys && !keys.includes(key)),
		)
	)
		throw new Error("Unknown or unsafe media field");
	return row;
}
function text(value: unknown, max = 512): void {
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max)
		throw new Error("Invalid media text");
}
function identifier(value: unknown): void {
	if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid media identifier");
}
function number(value: unknown, min: number, max: number, integer = false): void {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max ||
		(integer && !Number.isSafeInteger(value))
	)
		throw new Error("Invalid media number");
}
function json(value: unknown, depth = 0): void {
	if (depth > 8) throw new Error("Media options are too deeply nested");
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		if (value.length > 8000 || value.includes("\0")) throw new Error("Media option is too large");
		return;
	}
	if (typeof value === "number") {
		number(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
		return;
	}
	const values = Array.isArray(value) ? value : Object.values(object(value));
	if (values.length > 64) throw new Error("Too many media options");
	values.forEach(item => json(item, depth + 1));
}
export function mediaInputArtifacts(request: MediaRequest): string[] {
	return [
		...new Set(
			request.type === "image"
				? (request.inputArtifacts ?? [])
				: request.type === "transcription"
					? [request.audioArtifact]
					: request.type === "video"
						? [
								...(request.firstFrame ? [request.firstFrame] : []),
								...(request.lastFrame ? [request.lastFrame] : []),
								...(request.references?.map(ref => ref.artifactId) ?? []),
							]
						: [],
		),
	];
}
export function validateMediaRequest(value: unknown): asserts value is MediaRequest {
	const type = (value as { type?: unknown } | null)?.type;
	const fields =
		type === "image"
			? ["prompt", "inputArtifacts", "aspectRatio", "imageSize", "count"]
			: type === "video"
				? [
						"prompt",
						"duration",
						"resolution",
						"aspectRatio",
						"size",
						"firstFrame",
						"lastFrame",
						"references",
						"generateAudio",
						"seed",
						"creativity",
						"upscaleFactor",
						"providerOptions",
					]
				: type === "transcription"
					? ["audioArtifact", "language", "prompt", "timestamps", "temperature"]
					: type === "speech"
						? ["text", "voice", "format", "speed", "sampleRate", "bitRate", "instructions"]
						: undefined;
	if (!fields) throw new Error("Unknown media kind");
	const input = object(value, ["type", "model", ...fields]);
	if (input.model !== undefined || type === "video") text(input.model);
	if (type === "image" || input.prompt !== undefined) text(input.prompt, 32000);
	for (const field of ["aspectRatio", "imageSize", "resolution", "size", "language", "voice"])
		if (input[field] !== undefined) text(input[field], 128);
	if (type === "image") {
		if (input.count !== undefined) number(input.count, 1, 4, true);
		if (input.inputArtifacts !== undefined) {
			if (!Array.isArray(input.inputArtifacts) || input.inputArtifacts.length > 8)
				throw new Error("Use at most 8 input images");
			input.inputArtifacts.forEach(identifier);
		}
	}
	if (type === "video") {
		for (const field of ["firstFrame", "lastFrame"]) if (input[field] !== undefined) identifier(input[field]);
		if (input.references !== undefined) {
			if (!Array.isArray(input.references) || input.references.length > 8)
				throw new Error("Too many video references");
			for (const ref of input.references) {
				const row = object(ref, ["artifactId", "type"]);
				identifier(row.artifactId);
				if (!["image", "audio", "video"].includes(row.type as string)) throw new Error("Invalid video reference");
			}
		}
		if (input.duration !== undefined) number(input.duration, 1, 120);
		if (input.seed !== undefined) number(input.seed, 0, 2147483647, true);
		if (input.creativity !== undefined) number(input.creativity, 0, 1);
		if (input.upscaleFactor !== undefined) number(input.upscaleFactor, 1, 4);
		if (input.generateAudio !== undefined && typeof input.generateAudio !== "boolean")
			throw new Error("Invalid video audio flag");
		if (input.providerOptions !== undefined) {
			object(input.providerOptions);
			json(input.providerOptions);
			if (JSON.stringify(input.providerOptions).length > 16000) throw new Error("Provider options exceed 16 KB");
		}
	}
	if (type === "transcription") {
		identifier(input.audioArtifact);
		if (input.timestamps !== undefined && !["none", "word", "segment"].includes(input.timestamps as string))
			throw new Error("Invalid timestamp mode");
		if (input.temperature !== undefined) number(input.temperature, 0, 1);
	}
	if (type === "speech") {
		text(input.text, 15000);
		if (!["mp3", "wav", "pcm", "opus", "aac", "flac"].includes(input.format as string))
			throw new Error("Invalid speech format");
		if (input.instructions !== undefined) text(input.instructions, 8000);
		if (input.speed !== undefined) number(input.speed, 0.25, 4);
		if (input.sampleRate !== undefined) number(input.sampleRate, 8000, 48000, true);
		if (input.bitRate !== undefined) number(input.bitRate, 8000, 320000, true);
	}
}
export function validateMediaOperation(value: unknown): asserts value is MediaOperation {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !isMediaOperationKind(kind)) throw new Error("Unknown media operation");
	const input = object(value, [
		"kind",
		"sessionId",
		...(kind === "media.models"
			? ["cursor"]
			: kind === "media.start"
				? ["request", "inputTransfers"]
				: kind === "media.list"
					? []
					: ["id"]),
	]);
	text(input.sessionId);
	if (input.cursor !== undefined) text(input.cursor);
	if (input.id !== undefined) identifier(input.id);
	if (kind === "media.start") {
		validateMediaRequest(input.request);
		if (input.inputTransfers !== undefined) {
			if (!Array.isArray(input.inputTransfers) || input.inputTransfers.length > 10)
				throw new Error("Invalid input grants");
			for (const entry of input.inputTransfers) {
				const row = object(entry, ["artifactId", "transferId"]);
				identifier(row.artifactId);
				identifier(row.transferId);
			}
		}
	} else if (kind !== "media.models" && kind !== "media.list") identifier(input.id);
}
