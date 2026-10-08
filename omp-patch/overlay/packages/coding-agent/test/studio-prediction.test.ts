import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { TempDir, getPredictStateDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { TextPredictionClient } from "../src/predict/client";
import {
	TEXT_PREDICT_AGENT_DIR_ENV,
	TEXT_PREDICT_PROFILE_ENV,
	TEXT_PREDICT_SOCKET_ENV,
	type TextPredictResponse,
} from "../src/predict/protocol";
import { connectJsonlSocket, LineParser, writeJsonLine } from "../src/tiny/jsonl-socket";
import { StudioPredictionService } from "../src/studio/services/prediction-service";
import {
	validatePredictionEvent,
	validatePredictionChannelResult,
	type PredictionChannel,
	type PredictionEvent,
} from "../src/studio/prediction-channel-protocol";
test("prediction channels keep prose private, apply native prose gates and close when session ownership changes", async () => {
	const temp = TempDir.createSync("@studio-prediction-");
	const session = { sessionId: "main", settings: Settings.isolated() } as AgentSession;
	const complete = spyOn(TextPredictionClient.prototype, "complete").mockResolvedValue({
		engine: "ngram",
		suggestion: { suffix: "view", confidence: 0.99 },
	});
	const service = new StudioPredictionService(session, temp.path(), temp.path());
	let socket: net.Socket | undefined;
	try {
		const prepared = (await service.execute({ kind: "prediction.prepare", sessionId: "main" })) as PredictionChannel;
		validatePredictionChannelResult("prediction.prepare", prepared);
		const descriptor = (await Bun.file(
			path.join(temp.path(), "prediction", prepared.channelId + ".json"),
		).json()) as { token: string; endpoint: string };
		expect(JSON.stringify(prepared)).not.toContain(descriptor.token);
		expect(JSON.stringify(prepared)).not.toContain(descriptor.endpoint);
		socket = await connectJsonlSocket(descriptor.endpoint, 1000);
		const frames: PredictionEvent[] = [];
		let authenticated = false;
		const parser = new LineParser(line => {
			if (line === "OK") {
				authenticated = true;
				return;
			}
			const event: unknown = JSON.parse(line);
			validatePredictionEvent(event);
			frames.push(event);
		});
		socket.on("data", (part: string) => parser.push(part));
		socket.write(descriptor.token + "\n");
		const until = async (check: () => boolean) => {
			const deadline = Date.now() + 3000;
			while (!check() && Date.now() < deadline) await Bun.sleep(5);
			expect(check()).toBe(true);
		};
		await until(() => authenticated);
		writeJsonLine(socket, { kind: "update", revision: 1, text: "please re", caret: 9 });
		await until(() =>
			frames.some(event => event.kind === "suggestion" && event.revision === 1 && event.suffix === "view"),
		);
		expect(complete).toHaveBeenCalledWith("ngram", "please ", "re");
		writeJsonLine(socket, { kind: "update", revision: 2, text: "/command re", caret: 11 });
		await until(() =>
			frames.some(event => event.kind === "suggestion" && event.revision === 2 && event.suffix === null),
		);
		expect(complete).toHaveBeenCalledTimes(1);
		Object.assign(session, { sessionId: "other" });
		writeJsonLine(socket, { kind: "update", revision: 3, text: "please re", caret: 9 });
		await until(() => socket!.destroyed);
		await expect(service.execute({ kind: "prediction.status", sessionId: "main" })).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
		});
	} finally {
		socket?.destroy();
		service.dispose();
		complete.mockRestore();
		await temp.remove();
	}
});
test("the native Studio daemon never bootstraps foreign history and persists explicit imports separately", async () => {
	const temp = TempDir.createSync("@studio-predict-policy-");
	const endpoint =
		process.platform === "win32"
			? "\\\\.\\pipe\\studio-predict-test-" + crypto.randomUUID()
			: path.join(temp.path(), "predict.sock");
	const marker = path.join(temp.path(), "foreign-seed-probe"),
		agentDir = path.join(temp.path(), "agent");
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			path.join(import.meta.dir, "fixtures/studio-prediction-preload.ts"),
			path.join(import.meta.dir, "../src/cli.ts"),
			"__omp_worker_text_predict",
		],
		{
			env: {
				...process.env,
				[TEXT_PREDICT_AGENT_DIR_ENV]: agentDir,
				[TEXT_PREDICT_SOCKET_ENV]: endpoint,
				[TEXT_PREDICT_PROFILE_ENV]: "studio",
				STUDIO_PREDICT_SEED_PROBE: marker,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stdout = new Response(child.stdout).text(),
		stderr = new Response(child.stderr).text();
	let socket: net.Socket | undefined;
	let nextId = 1;
	const pending = new Map<
		number,
		{ resolve: (value: TextPredictResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	try {
		const deadline = Date.now() + 30000;
		while (!socket && child.exitCode === null && Date.now() < deadline) {
			try {
				socket = await connectJsonlSocket(endpoint, 1000);
			} catch {
				await Bun.sleep(100);
			}
		}
		if (!socket)
			throw new Error(
				"Prediction daemon did not start: " + (child.exitCode === null ? "startup timeout" : await stderr),
			);
		const parser = new LineParser(line => {
			const result = JSON.parse(line) as TextPredictResponse;
			const request = pending.get(result.id);
			if (request) {
				clearTimeout(request.timer);
				pending.delete(result.id);
				request.resolve(result);
			}
		});
		socket.on("data", (part: string) => parser.push(part));
		const call = (operation: Record<string, unknown>): Promise<TextPredictResponse> => {
			const id = nextId++,
				promise = Promise.withResolvers<TextPredictResponse>();
			const timer = setTimeout(() => {
				pending.delete(id);
				promise.reject(new Error("Daemon response timed out"));
			}, 15000);
			pending.set(id, { ...promise, timer });
			writeJsonLine(socket!, { ...operation, id });
			return promise.promise;
		};
		expect(await call({ op: "ping" })).toMatchObject({ ok: true, profile: "studio", protocol: 2 });
		expect(await call({ op: "complete", method: "ngram", before: "please ", prefix: "re" })).toMatchObject({
			ok: true,
			op: "complete",
		});
		expect(await Bun.file(marker).exists()).toBe(false);
		expect(await call({ op: "import", prompts: ["please verify private prediction"] })).toMatchObject({
			ok: true,
			op: "import",
			ingested: 1,
		});
		expect((await fs.stat(getPredictStateDir(path.join(agentDir, "studio-predict"), "ngram"))).isDirectory()).toBe(
			true,
		);
		expect(await Bun.file(marker).exists()).toBe(false);
		await expect(fs.stat(getPredictStateDir(agentDir, "ngram"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await call({ op: "import", prompts: Array.from({ length: 129 }, () => "over limit") })).toMatchObject({
			ok: false,
		});
		await call({ op: "shutdown" });
		await child.exited;
	} finally {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Test finished"));
		}
		pending.clear();
		socket?.destroy();
		child.kill();
		await child.exited;
		await Promise.all([stdout, stderr]);
		await temp.remove();
	}
}, 60000);
