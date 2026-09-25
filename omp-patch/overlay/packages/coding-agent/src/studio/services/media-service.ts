import { randomUUID } from "node:crypto";
import { generateImage, isImageGenerationApi, type Model } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import { submitVideo, pollVideo, downloadVideo, type VideoGenerationRequest } from "@oh-my-pi/pi-ai/video";
import { resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import type { AgentSession } from "../../session/agent-session";
import { resolveHostedImageCarrier } from "../../tools/image-gen";
import { resolveSpeechCandidates } from "../../tools/tts";
import { sttClient } from "../../stt/asr-client";
import { resolveSttModelSpec } from "../../stt/models";
import { ttsClient } from "../../tts/tts-client";
import { DEFAULT_TTS_VOICE, KOKORO_VOICES } from "../../tts/models";
import { encodeWav } from "../../tts/wav";
import {
	type MediaDetail,
	type MediaJob,
	type MediaModelChoice,
	type MediaOperation,
	type MediaRequest,
	mediaInputArtifacts,
	validateMediaOperation,
	validateMediaResult,
} from "../media-protocol";
import { StudioMediaFiles } from "./media-files";
import { SessionControlError } from "./session-control-service";

interface StoredJob extends MediaDetail {
	schemaVersion: 1;
	instance: string;
	remoteJobId?: string;
}
interface Task {
	stored: StoredJob;
	controller: AbortController;
	tail: Promise<void>;
	promise?: Promise<void>;
}
export interface StudioMediaDependencies {
	files?: StudioMediaFiles;
	generateImage?: typeof generateImage;
	synthesizeSpeech?: typeof synthesizeSpeech;
	transcribeAudio?: typeof transcribeAudio;
	submitVideo?: typeof submitVideo;
	pollVideo?: typeof pollVideo;
	downloadVideo?: typeof downloadVideo;
	pollIntervalMs?: number;
}
const active = (job: MediaJob) => ["queued", "running", "waiting"].includes(job.state);
const ext = (mime: string) =>
	({
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"audio/mpeg": "mp3",
		"audio/wav": "wav",
		"audio/opus": "opus",
		"audio/aac": "aac",
		"audio/flac": "flac",
		"audio/pcm": "pcm",
		"video/mp4": "mp4",
		"video/webm": "webm",
	})[mime] ?? "bin";
const delay = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const aborted = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", aborted);
			resolve();
		}, ms);
		signal.addEventListener("abort", aborted, { once: true });
	});
const errorText = (cause: unknown) =>
	cause instanceof SessionControlError
		? cause.message
		: cause instanceof ProviderHttpError
			? `Provider request failed (HTTP ${cause.status ?? "error"}). Check the selected model, supported parameters and account status.`
			: "Media processing failed. Check the model, its credentials, input format and local model dependencies.";

export function describeMediaModel(model: Model): MediaModelChoice | undefined {
	const base = {
		selector: `${model.provider}/${model.id}`,
		name: model.name.slice(0, 512),
		api: model.api,
		local: model.api === "local-inference",
	};
	if (model.kind === "image" && isImageGenerationApi(model.api))
		return {
			...base,
			kind: "image",
			parameters: [
				"prompt",
				"inputArtifacts",
				"aspectRatio",
				"imageSize",
				...(["openai-responses", "openai-codex-responses"].includes(model.api) ? [] : ["count"]),
			],
		};
	if (model.kind === "video" && model.api === "openrouter-video")
		return {
			...base,
			kind: "video",
			parameters: [
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
			],
		};
	if (model.kind === "stt" && (model.api === "openai-transcriptions" || model.api === "local-inference"))
		return {
			...base,
			kind: "transcription",
			parameters: ["audioArtifact", "language", ...(base.local ? [] : ["prompt", "timestamps", "temperature"])],
		};
	if (model.kind === "tts" && ["openai-speech", "xai-tts", "local-inference"].includes(model.api))
		return {
			...base,
			kind: "speech",
			parameters: [
				"text",
				"voice",
				"format",
				...(base.local ? [] : model.api === "xai-tts" ? ["sampleRate", "bitRate"] : ["speed", "instructions"]),
			],
			formats: base.local
				? ["wav"]
				: model.api === "xai-tts"
					? ["mp3", "wav"]
					: ["mp3", "wav", "pcm", "opus", "aac", "flac"],
			...(base.local
				? { voices: [...KOKORO_VOICES] }
				: model.api === "xai-tts"
					? { voices: ["ara", "eve", "leo", "rex", "sal"].map(id => ({ id, label: id })) }
					: {}),
		};
	return undefined;
}
function localWav(bytes: Uint8Array): Float32Array {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")
		throw new SessionControlError(
			"INVALID_ARGUMENT",
			"Local transcription requires a normalized 16 kHz mono PCM16 WAV; use Studio audio import/recording",
		);
	let format = false;
	let data: Buffer | undefined;
	for (let offset = 12; offset + 8 <= buffer.length;) {
		const name = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		if (offset + 8 + size > buffer.length) throw new Error("Incomplete WAV");
		if (name === "fmt " && size >= 16)
			format =
				buffer.readUInt16LE(offset + 8) === 1 &&
				buffer.readUInt16LE(offset + 10) === 1 &&
				buffer.readUInt32LE(offset + 12) === 16000 &&
				buffer.readUInt16LE(offset + 22) === 16;
		if (name === "data") data = buffer.subarray(offset + 8, offset + 8 + size);
		offset += 8 + size + (size % 2);
	}
	if (!format || !data || data.length % 2)
		throw new SessionControlError(
			"INVALID_ARGUMENT",
			"Normalize the audio to 16 kHz mono PCM16 WAV for local transcription",
		);
	const samples = new Float32Array(data.length / 2);
	for (let index = 0; index < samples.length; index++) samples[index] = data.readInt16LE(index * 2) / 32768;
	return samples;
}

/** Media remains owned by this AgentSession. Only explicit start submits billable work. */
export class StudioMediaService {
	readonly #instance = randomUUID();
	readonly #tasks = new Map<string, Task>();
	readonly #loaded = new Map<string, Promise<void>>();
	readonly #files: StudioMediaFiles | undefined;
	readonly #unsubscribe: () => void;
	#disposed = false;
	#operations: Promise<unknown> = Promise.resolve();
	constructor(
		readonly session: AgentSession,
		readonly dependencies: StudioMediaDependencies = {},
	) {
		this.#files =
			dependencies.files ??
			(process.env.OMP_STUDIO_MEDIA_ROOT ? new StudioMediaFiles(process.env.OMP_STUDIO_MEDIA_ROOT) : undefined);
		this.#unsubscribe =
			session.registerSessionChangeCallback?.(() => {
				for (const [id, task] of this.#tasks) {
					if (task.stored.job.sessionId === session.sessionId) continue;
					this.#loaded.delete(task.stored.job.sessionId);
					if (task.promise) task.controller.abort();
					else this.#tasks.delete(id);
				}
			}) ?? (() => {});
	}
	get running(): boolean {
		return [...this.#tasks.values()].some(task => active(task.stored.job));
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		for (const task of this.#tasks.values()) task.controller.abort();
	}
	async #load(sessionId: string): Promise<void> {
		if (!this.#files) return;
		let load = this.#loaded.get(sessionId);
		if (!load) {
			load = (async () => {
				for (const value of await this.#files!.readJobs(sessionId)) {
					try {
						const stored = value as StoredJob;
						if (stored.schemaVersion !== 1 || stored.job.sessionId !== sessionId) continue;
						const { job, request, outputs, text, textTruncated } = stored;
						validateMediaResult("media.read", {
							job,
							request,
							outputs,
							...(text ? { text } : {}),
							...(textTruncated ? { textTruncated } : {}),
						});
						if (this.#tasks.has(job.id)) continue;
						if (active(job)) {
							job.state = "interrupted";
							job.canResume = job.type === "video" && !!stored.remoteJobId;
							job.error = job.canResume
								? "Runtime stopped while waiting. Resume queries the same remote video task."
								: "Runtime stopped before completion was confirmed. Check provider history before submitting again; a request may have been accepted and billed.";
						}
						this.#tasks.set(job.id, { stored, controller: new AbortController(), tail: Promise.resolve() });
					} catch {
						/* Do not execute malformed stored jobs. */
					}
				}
			})();
			this.#loaded.set(sessionId, load);
		}
		await load;
	}
	#persist(task: Task): Promise<void> {
		task.stored.job.updatedAt = Date.now();
		const snapshot = structuredClone(task.stored);
		task.tail = task.tail
			.catch(() => {})
			.then(() => this.#files!.saveJob(snapshot.job.sessionId, snapshot.job.id, snapshot));
		return task.tail;
	}
	execute(operation: MediaOperation): Promise<unknown> {
		const work = this.#operations.then(() => this.#executeFenced(operation));
		this.#operations = work.catch(() => {});
		return work;
	}
	async #executeFenced(operation: MediaOperation): Promise<unknown> {
		validateMediaOperation(operation);
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Media actions require the current session");
		await this.#load(operation.sessionId);
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Session changed while loading media tasks");
		const result = await this.#execute(operation);
		validateMediaResult(operation.kind, result);
		return structuredClone(result);
	}
	async #execute(operation: MediaOperation): Promise<unknown> {
		if (operation.kind === "media.models") {
			const models = this.session.modelRegistry
				.getAvailable("all")
				.map(describeMediaModel)
				.filter((model): model is MediaModelChoice => !!model)
				.sort((a, b) => a.selector.localeCompare(b.selector));
			const start = operation.cursor ? models.findIndex(model => model.selector > operation.cursor!) : 0;
			const page = start < 0 ? [] : models.slice(start, start + 100);
			return {
				available: !!this.#files,
				models: page,
				...(start >= 0 && start + page.length < models.length && page.length
					? { nextCursor: page[page.length - 1]!.selector }
					: {}),
			};
		}
		const own = [...this.#tasks.values()].filter(task => task.stored.job.sessionId === operation.sessionId);
		if (operation.kind === "media.list")
			return {
				available: !!this.#files,
				jobs: own
					.map(task => task.stored.job)
					.sort((a, b) => b.createdAt - a.createdAt)
					.slice(0, 50),
			};
		if (!this.#files)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"The authenticated desktop media file channel is unavailable",
			);
		if (operation.kind === "media.start") {
			if (own.length >= 50 || own.filter(task => active(task.stored.job)).length >= 4)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Keep at most 4 active and 50 retained media tasks; close old tasks first",
				);
			const required = mediaInputArtifacts(operation.request);
			const grants = new Map(operation.inputTransfers?.map(row => [row.artifactId, row.transferId]) ?? []);
			if (required.some(id => !grants.has(id)) || grants.size !== required.length)
				throw new SessionControlError(
					"INVALID_ARGUMENT",
					"Media inputs must be staged by the desktop artifact boundary",
				);
			this.#candidates(operation.request); // Resolve before recording or submitting a task.
			const id = randomUUID();
			const task: Task = {
				stored: {
					schemaVersion: 1,
					instance: this.#instance,
					job: {
						id,
						sessionId: operation.sessionId,
						type: operation.request.type,
						state: "queued",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						canResume: false,
						outputCount: 0,
					},
					request: structuredClone(operation.request),
					outputs: [],
				},
				controller: new AbortController(),
				tail: Promise.resolve(),
			};
			this.#tasks.set(id, task);
			await this.#persist(task);
			this.#launch(task, grants);
			return { job: task.stored.job };
		}
		const task = this.#tasks.get(operation.id);
		if (!task || task.stored.job.sessionId !== operation.sessionId)
			throw new SessionControlError("INVALID_ARGUMENT", "Media task is not available in this session");
		if (operation.kind === "media.read") {
			const { job, request, outputs, text, textTruncated } = task.stored;
			return {
				job,
				request,
				outputs,
				...(text ? { text } : {}),
				...(textTruncated === undefined ? {} : { textTruncated }),
			};
		}
		if (operation.kind === "media.cancel") {
			task.controller.abort();
			if (!task.promise) task.stored.job.state = task.stored.remoteJobId ? "paused" : "cancelled";
			await this.#persist(task);
			return { job: task.stored.job };
		}
		if (operation.kind === "media.resume") {
			if (!active(task.stored.job)) await task.promise;
			if (
				!task.stored.remoteJobId ||
				!task.stored.job.canResume ||
				task.stored.job.type !== "video" ||
				active(task.stored.job)
			)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Only a stopped video task with a confirmed remote job can resume polling",
				);
			task.controller = new AbortController();
			task.stored.job.state = "queued";
			delete task.stored.job.error;
			await this.#persist(task);
			this.#launch(task, new Map());
			return { job: task.stored.job };
		}
		if (active(task.stored.job)) throw new SessionControlError("COMMAND_BLOCKED", "Stop the task before closing it");
		await task.promise;
		// Operations are serialized and the worker has settled: no writer can resurrect this job.
		await task.tail;
		await this.#files.removeJob(operation.sessionId, operation.id, task.stored.outputs);
		this.#tasks.delete(operation.id);
		return { closed: true };
	}
	#candidates(request: MediaRequest): Model[] {
		const role = request.type === "transcription" ? "dictation" : request.type === "speech" ? "speech" : request.type;
		// Upstream has no built-in video role; video always uses the explicitly selected kind model.
		const pool =
			request.type === "video"
				? this.session.modelRegistry.getAvailable("all").filter(model => model.kind === "video")
				: roleCandidatePool(role, this.session.settings, this.session.modelRegistry);
		const candidates = request.model
			? pool.filter(model => `${model.provider}/${model.id}` === request.model)
			: request.type === "speech"
				? resolveSpeechCandidates(this.session.settings, this.session.modelRegistry, request.format === "mp3").map(
						candidate => candidate.model,
					)
				: resolveRoleChain(role, this.session.settings, pool).map(candidate => candidate.model);
		const supported = candidates.filter(model => describeMediaModel(model)?.kind === request.type);
		if (!supported.length)
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"No supported model is available for this media role or selector",
			);
		return supported;
	}
	#launch(task: Task, grants: Map<string, string>): void {
		task.promise = this.#run(task, grants).finally(() => {
			delete task.promise;
			if (task.stored.job.sessionId !== this.session.sessionId || this.#disposed)
				this.#tasks.delete(task.stored.job.id);
		});
		void task.promise.catch(() => {});
	}
	async #run(task: Task, grants: Map<string, string>): Promise<void> {
		const { stored, controller } = task;
		const { request, job } = stored;
		const signal = controller.signal;
		const files = this.#files!;
		const inputs = new Map<string, Promise<Awaited<ReturnType<StudioMediaFiles["input"]>>>>();
		const input = (id: string, kind?: "image" | "audio" | "video") => {
			let result = inputs.get(id);
			if (!result) {
				const transferId = grants.get(id);
				if (!transferId) throw new SessionControlError("INVALID_ARGUMENT", "Input file grant is missing");
				result = files.input(transferId, kind);
				inputs.set(id, result);
			}
			return result.then(value => {
				if (kind && value.meta.kind !== kind)
					throw new SessionControlError(
						"INVALID_ARGUMENT",
						"Media input kind does not match the requested reference",
					);
				return value;
			});
		};
		try {
			job.state = "running";
			await this.#persist(task);
			const candidates = this.#candidates(request);
			let succeeded = false;
			for (const model of candidates) {
				signal.throwIfAborted();
				if (job.sessionId !== this.session.sessionId || this.#disposed) throw new Error("Session changed");
				const descriptor = describeMediaModel(model)!;
				for (const key of Object.keys(request))
					if (!["type", "model"].includes(key) && !descriptor.parameters.includes(key))
						throw new SessionControlError(
							"INVALID_ARGUMENT",
							`The selected ${model.api} transport does not support ${key}`,
						);
				if (
					request.type === "speech" &&
					model.api !== "local-inference" &&
					!descriptor.formats?.includes(request.format)
				)
					throw new SessionControlError(
						"INVALID_ARGUMENT",
						"The selected speech model does not support this output format",
					);
				job.model = `${model.provider}/${model.id}`;
				await this.#persist(task);
				const resolved = {
					...model,
					resolveHeaders: (headerSignal?: AbortSignal) =>
						this.session.modelRegistry.resolveModelHeaders(model, headerSignal),
				};
				const apiKey = this.session.modelRegistry.resolver(model, job.sessionId);
				try {
					if (request.type === "image") {
						const imageInputs = await Promise.all(
							(request.inputArtifacts ?? []).map(async id => {
								const value = await input(id, "image");
								return { data: Buffer.from(value.bytes).toString("base64"), mimeType: value.meta.mimeType };
							}),
						);
						const carrier = ["openai-responses", "openai-codex-responses"].includes(model.api)
							? resolveHostedImageCarrier(this.session.modelRegistry, model, this.session.model)
							: undefined;
						const result = await (this.dependencies.generateImage ?? generateImage)(
							resolved,
							{
								prompt: request.prompt,
								inputImages: imageInputs,
								aspectRatio: request.aspectRatio,
								imageSize: request.imageSize,
								count: request.count ?? 1,
							},
							{
								apiKey: carrier ? this.session.modelRegistry.resolver(carrier, job.sessionId) : apiKey,
								signal,
								sessionId: job.sessionId,
								...(carrier
									? {
											carrier: {
												...carrier,
												resolveHeaders: (headerSignal?: AbortSignal) =>
													this.session.modelRegistry.resolveModelHeaders(carrier, headerSignal),
											},
										}
									: {}),
							},
						);
						if (result.images.length > 4) throw new Error("Provider returned too many images");
						for (const [index, image] of result.images.entries()) {
							if (image.data.length > 96 * 1024 * 1024 || !image.mimeType.startsWith("image/"))
								throw new Error("Image output exceeds budget");
							stored.outputs.push(
								await files.outputBytes(
									{
										kind: "image",
										name: `${job.id}-${index + 1}.${ext(image.mimeType)}`,
										mimeType: image.mimeType,
									},
									Buffer.from(image.data, "base64"),
									job.sessionId,
								),
							);
						}
						if (result.text?.trim()) {
							stored.text = result.text.slice(0, 60000);
							stored.textTruncated = result.text.length > 60000;
						}
						job.cost = result.usage.cost.total;
					} else if (request.type === "speech") {
						let audio: Uint8Array;
						let mimeType: string;
						if (model.api === "local-inference") {
							const value = await ttsClient.synthesize(model.id, request.text, {
								voice: request.voice ?? this.session.settings.get("tts.localVoice") ?? DEFAULT_TTS_VOICE,
								signal,
							});
							if (!value) throw new Error("Local speech unavailable");
							audio = encodeWav(value.pcm, value.sampleRate);
							mimeType = "audio/wav";
							job.cost = 0;
						} else {
							const result = await (this.dependencies.synthesizeSpeech ?? synthesizeSpeech)(
								resolved,
								{
									text: request.text,
									format: request.format,
									voice: request.voice,
									speed: request.speed,
									instructions: request.instructions,
									sampleRate: request.sampleRate,
									bitRate: request.bitRate,
								},
								{ apiKey, signal },
							);
							audio = result.audio;
							mimeType = result.mimeType;
							job.cost = result.usage.cost.total;
						}
						stored.outputs.push(
							await files.outputBytes(
								{ kind: "audio", name: `${job.id}.${ext(mimeType)}`, mimeType },
								audio,
								job.sessionId,
							),
						);
					} else if (request.type === "transcription") {
						const audio = await input(request.audioArtifact, "audio");
						let result: { text: string; [key: string]: unknown };
						if (model.api === "local-inference") {
							result = {
								text: await sttClient.transcribe(resolveSttModelSpec(model.id).key, localWav(audio.bytes), {
									language: request.language,
									signal,
								}),
							};
							job.cost = 0;
						} else {
							const value = await (this.dependencies.transcribeAudio ?? transcribeAudio)(
								resolved,
								{
									audio: audio.bytes,
									mimeType: audio.meta.mimeType,
									fileName: audio.meta.name,
									language: request.language,
									prompt: request.prompt,
									temperature: request.temperature,
									responseFormat:
										request.timestamps && request.timestamps !== "none" ? "verbose_json" : "json",
									...(request.timestamps && request.timestamps !== "none"
										? { timestampGranularities: [request.timestamps] }
										: {}),
								},
								{ apiKey, signal },
							);
							result = { ...value };
							job.cost = value.usage.cost.total;
						}
						stored.text = result.text.slice(0, 60000);
						stored.textTruncated = result.text.length > 60000;
						stored.outputs.push(
							await files.outputBytes(
								{ kind: "transcript", name: `${job.id}.json`, mimeType: "application/json" },
								Buffer.from(JSON.stringify(result)),
								job.sessionId,
							),
						);
					} else {
						if (!stored.remoteJobId) {
							const url = async (id: string, kind: "image" | "video" | "audio") => {
								const value = await input(id, kind);
								return `data:${value.meta.mimeType};base64,${Buffer.from(value.bytes).toString("base64")}`;
							};
							const frameImages: NonNullable<VideoGenerationRequest["frameImages"]> = [];
							if (request.firstFrame)
								frameImages.push({
									type: "image_url",
									imageUrl: { url: await url(request.firstFrame, "image") },
									frameType: "first_frame",
								});
							if (request.lastFrame)
								frameImages.push({
									type: "image_url",
									imageUrl: { url: await url(request.lastFrame, "image") },
									frameType: "last_frame",
								});
							const references: NonNullable<VideoGenerationRequest["inputReferences"]> = [];
							for (const ref of request.references ?? []) {
								const value = await url(ref.artifactId, ref.type);
								references.push(
									ref.type === "image"
										? { type: "image_url", imageUrl: { url: value } }
										: ref.type === "audio"
											? { type: "audio_url", audioUrl: { url: value } }
											: { type: "video_url", videoUrl: { url: value } },
								);
							}
							const remote = await (this.dependencies.submitVideo ?? submitVideo)(
								resolved,
								{
									prompt: request.prompt,
									duration: request.duration,
									resolution: request.resolution as VideoGenerationRequest["resolution"],
									aspectRatio: request.aspectRatio as VideoGenerationRequest["aspectRatio"],
									size: request.size,
									generateAudio: request.generateAudio,
									seed: request.seed,
									creativity: request.creativity,
									upscaleFactor: request.upscaleFactor,
									frameImages,
									inputReferences: references,
									...(request.providerOptions ? { provider: { options: request.providerOptions } } : {}),
									sessionId: job.sessionId,
								},
								{ apiKey, signal },
							);
							stored.remoteJobId = remote.id;
							job.canResume = true;
							await this.#persist(task);
						}
						job.state = "waiting";
						await this.#persist(task);
						for (;;) {
							signal.throwIfAborted();
							const remote = await (this.dependencies.pollVideo ?? pollVideo)(resolved, stored.remoteJobId!, {
								apiKey,
								signal,
							});
							if (remote.usage) job.cost = remote.usage.cost.total;
							if (remote.status === "completed") break;
							if (["failed", "cancelled", "expired"].includes(remote.status))
								throw new SessionControlError(
									"INVALID_ARGUMENT",
									`The provider reports this video task as ${remote.status}`,
								);
							await delay(this.dependencies.pollIntervalMs ?? 5000, signal);
						}
						const content = await (this.dependencies.downloadVideo ?? downloadVideo)(
							resolved,
							stored.remoteJobId!,
							{ apiKey, signal },
						);
						const mimeType = content.contentType.split(";", 1)[0]!.trim().toLowerCase();
						if (!["video/mp4", "video/webm"].includes(mimeType)) {
							await content.body.cancel();
							throw new Error("Unexpected video response");
						}
						const chunks = async function* () {
							const reader = content.body.getReader();
							try {
								for (;;) {
									signal.throwIfAborted();
									const next = await reader.read();
									if (next.done) break;
									yield next.value;
								}
							} finally {
								await reader.cancel().catch(() => {});
							}
						};
						stored.outputs.push(
							await files.output(
								{ kind: "video", name: `${job.id}.${ext(mimeType)}`, mimeType },
								chunks(),
								job.sessionId,
							),
						);
					}
					succeeded = true;
					break;
				} catch (error) {
					if (!(error instanceof ProviderHttpError) || signal.aborted || request.type === "video" || request.model)
						throw error;
				}
			}
			if (!succeeded) throw new Error("All media role candidates failed");
			job.outputCount = stored.outputs.length;
			job.state = "completed";
			job.canResume = false;
		} catch (cause) {
			job.outputCount = stored.outputs.length;
			job.state = signal.aborted
				? stored.remoteJobId
					? "paused"
					: request.type === "video"
						? "interrupted"
						: "cancelled"
				: "failed";
			job.canResume = request.type === "video" && !!stored.remoteJobId;
			job.error = signal.aborted
				? request.type === "video"
					? stored.remoteJobId
						? "Stopped waiting locally. The provider may still be processing and charging for this video."
						: "Stopped before a remote job ID was confirmed. Check provider history before submitting again."
					: "Stopped locally. Requests already accepted by the provider may still be billed."
				: errorText(cause);
		} finally {
			await files.releaseInputs(grants.values());
			await this.#persist(task).catch(() => {
				job.error = "Unable to persist media job state; save any available outputs before exiting.";
			});
		}
	}
}
