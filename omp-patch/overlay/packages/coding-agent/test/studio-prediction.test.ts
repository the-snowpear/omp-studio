import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { TempDir, getPredictStateDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { TextPredictionClient } from "../src/predict/client";
import { IsolatedDaemon, waitFor } from "./fixtures/daemon-harness";
import { createInterface } from "node:readline";
import { once } from "node:events";
async function connectJsonlSocket(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const socket = net.createConnection(endpoint);
	try {
		await once(socket, "connect", { signal: AbortSignal.timeout(timeoutMs) });
		return socket;
	} catch (error) {
		socket.destroy();
		throw error;
	}
}
function writeJsonLine(socket: net.Socket, value: unknown): void {
	socket.write(JSON.stringify(value) + String.fromCharCode(10));
}
import { StudioPredictionService } from "../src/studio/services/prediction-service";
import { StudioPredictionEngine } from "../src/studio/services/prediction-engine";
import { type PredictionChannel, type PredictionEvent } from "../src/studio/prediction-channel-protocol";
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
		const descriptor = (await Bun.file(
			path.join(temp.path(), "prediction", prepared.channelId + ".json"),
		).json()) as { token: string; endpoint: string };
		expect(JSON.stringify(prepared)).not.toContain(descriptor.token);
		expect(JSON.stringify(prepared)).not.toContain(descriptor.endpoint);
		socket = await connectJsonlSocket(descriptor.endpoint, 1000);
		const frames: PredictionEvent[] = [];
		let authenticated = false;
		const lines = createInterface({ input: socket });
		lines.on("line", (line: string) => {
			if (line === "OK") {
				authenticated = true;
				return;
			}
			const event = JSON.parse(line) as PredictionEvent;
			frames.push(event);
		});

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
test("Studio prediction learns explicitly imported prompts in its private native daemon unit", async () => {
	const daemon = await IsolatedDaemon.create();
	const temp = TempDir.createSync("@studio-predict-policy-");
	const directory = temp.path();
	const client = new TextPredictionClient(directory, false, false);
	const engine = new StudioPredictionEngine(
		{ sessionId: "test", settings: Settings.isolated() },
		{ directory, client },
	);
	try {
		expect(await engine.importPrompts(["please verify private prediction"])).toBe(1);
		expect(await engine.importPrompts(["please verify private prediction"])).toBe(0);
		expect((await client.complete("ngram", "please ", "ve")).engine).toBe("ngram");
		await waitFor(
			async () => (await fs.stat(getPredictStateDir(directory, "ngram")).catch(() => undefined))?.isDirectory(),
			"Studio prediction state",
		);
		await client.stop();
	} finally {
		engine.dispose();
		await daemon.dispose();
		await temp.remove();
	}
}, 30000);
