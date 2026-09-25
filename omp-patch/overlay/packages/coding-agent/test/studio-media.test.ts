import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioMediaService } from "../src/studio/services/media-service";
import { StudioMediaFiles } from "../src/studio/services/media-files";
import type { MediaDetail, MediaJob } from "../src/studio/media-protocol";

const model = buildModel({
	provider: "mock",
	id: "video",
	api: "openrouter-video",
	kind: "video",
	name: "Video",
	baseUrl: "https://example.test",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
});
const session = {
	sessionId: "s",
	sessionManager: { getCwd: () => "." },
	settings: Settings.isolated(),
	modelRegistry: {
		getAll: () => [model],
		getAvailable: () => [model],
		resolver: () => (() => Promise.resolve("fake-key")) as unknown as ApiKeyResolver,
		resolveModelHeaders: async () => ({}),
	},
} as unknown as AgentSession;
async function until(service: StudioMediaService, id: string, state: string) {
	for (let i = 0; i < 200; i++) {
		const value = (await service.execute({ kind: "media.read", sessionId: "s", id })) as MediaDetail;
		if (value.job.state === state) return value;
		await Bun.sleep(5);
	}
	throw new Error("Media mock did not settle: " + state);
}
it("persists remote video identity and resumes polling without submitting another paid job", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-video-"));
	const files = new StudioMediaFiles(root);
	let submits = 0;
	const original = new StudioMediaService(session, {
		files,
		submitVideo: async () => {
			submits++;
			return { id: "provider-job", status: "queued" };
		},
		pollVideo: async () => ({ id: "provider-job", status: "processing" }),
		pollIntervalMs: 5,
	});
	try {
		const started = (await original.execute({
			kind: "media.start",
			sessionId: "s",
			request: { type: "video", model: "mock/video", prompt: "Mock video" },
		})) as { job: MediaJob };
		await until(original, started.job.id, "waiting");
		await original.execute({ kind: "media.cancel", sessionId: "s", id: started.job.id });
		await until(original, started.job.id, "paused");
		original.dispose();
		const recovered = new StudioMediaService(session, {
			files,
			submitVideo: async () => {
				throw new Error("Recovery must never resubmit");
			},
			pollVideo: async (_model, id) => {
				expect(id).toBe("provider-job");
				return { id, status: "completed" };
			},
			downloadVideo: async () => ({
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([1, 2, 3]));
						controller.close();
					},
				}),
				contentType: "video/mp4",
			}),
		});
		try {
			const listed = (await recovered.execute({ kind: "media.list", sessionId: "s" })) as { jobs: MediaJob[] };
			expect(listed.jobs[0]!.canResume).toBe(true);
			await recovered.execute({ kind: "media.resume", sessionId: "s", id: started.job.id });
			const done = await until(recovered, started.job.id, "completed");
			expect(done.outputs).toHaveLength(1);
			expect(done.outputs[0]!.bytes).toBe(3);
			expect(submits).toBe(1);
			expect(JSON.stringify(done)).not.toContain("provider-job");
			expect(JSON.stringify(done)).not.toContain(root);
			const wrong = await recovered
				.execute({ kind: "media.read", sessionId: "other", id: started.job.id })
				.catch(error => error);
			expect(wrong).toMatchObject({ code: "COMMAND_BLOCKED" });
		} finally {
			recovered.dispose();
		}
	} finally {
		original.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("uses single-use file grants for image/STT and saves native speech outputs without exposing bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-media-kinds-"));
	const { mkdir, writeFile, readdir, readFile } = await import("node:fs/promises");
	const { createHash, randomUUID } = await import("node:crypto");
	const files = new StudioMediaFiles(root);
	const models = [
		{ ...model, id: "image", kind: "image", api: "openai-images" },
		{ ...model, id: "stt", kind: "stt", api: "openai-transcriptions" },
		{ ...model, id: "tts", kind: "tts", api: "openai-speech" },
	];
	const mockSession = {
		...session,
		modelRegistry: { ...session.modelRegistry, getAll: () => models, getAvailable: () => models },
	} as unknown as AgentSession;
	const usage = { cost: { total: 0.25 } };
	let images = 0;
	let transcripts = 0;
	let speeches = 0;
	const service = new StudioMediaService(mockSession, {
		files,
		generateImage: async (_model, request) => {
			images++;
			expect(request.inputImages?.[0]?.data).toBe(Buffer.from("fixture").toString("base64"));
			return { images: [{ data: Buffer.from("output").toString("base64"), mimeType: "image/png" }], usage } as never;
		},
		transcribeAudio: async (_model, request) => {
			transcripts++;
			expect(Buffer.from(request.audio).toString()).toBe("fixture");
			return { text: "mock transcript", usage, segments: [{ start: 0, end: 1, text: "mock transcript" }] } as never;
		},
		synthesizeSpeech: async (_model, request) => {
			speeches++;
			expect(request.text).toBe("mock speech");
			return { audio: Buffer.from("speech"), mimeType: "audio/wav", usage } as never;
		},
	});
	const stage = async (kind: "audio" | "image") => {
		const transferId = randomUUID(),
			artifactId = randomUUID(),
			bytes = Buffer.from("fixture");
		await mkdir(join(root, "inputs"), { recursive: true });
		await writeFile(join(root, "inputs", transferId + ".bin"), bytes);
		await writeFile(
			join(root, "inputs", transferId + ".json"),
			JSON.stringify({
				artifactId: transferId,
				kind,
				name: "fixture",
				mimeType: kind === "audio" ? "audio/wav" : "image/png",
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			}),
		);
		return { transferId, artifactId };
	};
	try {
		const image = await stage("image"),
			audio = await stage("audio");
		const requests = [
			{
				request: { type: "image", model: "mock/image", prompt: "edit", inputArtifacts: [image.artifactId] },
				inputTransfers: [image],
			},
			{
				request: {
					type: "transcription",
					model: "mock/stt",
					audioArtifact: audio.artifactId,
					timestamps: "segment",
				},
				inputTransfers: [audio],
			},
			{ request: { type: "speech", model: "mock/tts", text: "mock speech", format: "wav" } },
		] as const;
		for (const request of requests) {
			const { job } = (await service.execute({ kind: "media.start", sessionId: "s", ...request } as never)) as {
				job: MediaJob;
			};
			const done = await until(service, job.id, "completed");
			expect(done.outputs).toHaveLength(1);
			expect(done.job.cost).toBe(0.25);
			expect(JSON.stringify(done)).not.toContain("transferId");
			const output = join(
				root,
				"outputs",
				createHash("sha256").update("s").digest("hex"),
				done.outputs[0]!.artifactId + ".bin",
			);
			expect((await readFile(output)).length).toBeGreaterThan(0);
			await service.execute({ kind: "media.close", sessionId: "s", id: job.id });
		}
		expect([images, transcripts, speeches]).toEqual([1, 1, 1]);
		expect(await readdir(join(root, "inputs"))).toEqual([]);
		expect(await files.readJobs("s")).toEqual([]);
		const restarted = new StudioMediaService(mockSession, { files });
		expect(await restarted.execute({ kind: "media.list", sessionId: "s" })).toEqual({ available: true, jobs: [] });
		restarted.dispose();
	} finally {
		service.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
