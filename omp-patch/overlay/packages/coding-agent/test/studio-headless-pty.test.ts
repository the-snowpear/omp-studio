import { BashTool } from "../src/tools/bash";
import type { ToolSession } from "../src/tools";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { releaseShellSessions } from "../src/exec/bash-executor";
import * as path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { AsyncJobManager } from "../src/async/job-manager";
import { runHeadlessBashPty, type HeadlessPtyControl, type HeadlessPtyState } from "../src/tools/bash-interactive";
import { canUseHeadlessBashPty, canUseInteractiveBashPty } from "../src/tools/bash-pty-selection";
import { StudioRemoteExtensionUiContext, type StudioUiGateway } from "../src/studio/remote-extension-ui";
import { inputStudioJob, inspectStudioJob, readStudioPtyInputWaits } from "../src/studio/services/job-inspect";
import { inspectAsyncJob } from "../src/session/async-job-views";
import type { AgentSession } from "../src/session/agent-session";

const dirs: TempDir[] = [],
	managers: AsyncJobManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
	for (const dir of dirs.splice(0)) dir.removeSync();
});

test("Studio GUI uses its headless PTY capability without invoking custom terminal UI", () => {
	const ui = new StudioRemoteExtensionUiContext({} as StudioUiGateway, "pty");
	const context = { hasUI: true, ui };
	expect(canUseHeadlessBashPty(true, context)).toBe(Bun.env.PI_NO_PTY !== "1");
	expect(canUseInteractiveBashPty(true, context)).toBe(false);
});

test("a real headless PTY accepts typed job input and finishes; stale input never writes again", async () => {
	const dir = TempDir.createSync("studio-headless-pty-");
	dirs.push(dir);
	const file = path.resolve(dir.path(), "prompt.ts");
	await Bun.write(
		file,
		`console.log("ENTER_VALUE"); process.stdin.setEncoding("utf8"); process.stdin.on("data", value => { if (String(value).trim()) { console.log("RECEIVED=" + String(value).trim()); process.exit(0); } });`,
	);
	const manager = new AsyncJobManager({});
	managers.push(manager);
	const settings = Settings.isolated();
	const outputReady = Promise.withResolvers<void>();
	let control: HeadlessPtyControl | undefined,
		state: HeadlessPtyState = { waiting: null, notify: false, canInput: false },
		output = "";
	const jobId = manager.register(
		"bash",
		"Interactive prompt",
		async ({ signal, reportProgress }) => {
			const details = () => ({
				pty: { ...state, sessionId: "child-session", toolCallId: "pty-call", command: "Interactive prompt" },
			});
			const result = await runHeadlessBashPty({
				command: "Interactive prompt",
				application: process.execPath,
				args: [file],
				cwd: path.resolve(dir.path()),
				env: {},
				settings,
				timeoutMs: 10000,
				signal,
				onControl: value => {
					control = value;
				},
				onOutput: text => {
					output = text;
					void reportProgress(text, details());
					if (text.includes("ENTER_VALUE")) outputReady.resolve();
				},
				onState: next => {
					state = next;
					void reportProgress(output, details());
				},
			});
			expect(result.exitCode).toBe(0);
			return result.output;
		},
		{
			ownerId: "Main",
			process: {
				command: "Interactive prompt",
				cwd: dir.path(),
				pids: () => (state.pid === undefined ? [] : [state.pid]),
				input: data => control!.input(data),
			},
		},
	);
	const session = {
		sessionId: "root-session",
		asyncJobManager: manager,
		inspectAsyncJob: (id: string) => inspectAsyncJob(manager, "Main", id),
	} as unknown as AgentSession;
	await outputReady.promise;
	const inspection = await inspectStudioJob(session, jobId);
	expect(inspection.canInput).toBe(true);
	if (process.platform === "win32") expect(inspection.inputDetection).toBe("unknown");
	const generation = inspection.inputGeneration!;
	await expect(inputStudioJob(session, jobId, generation - 1, "bad" + String.fromCharCode(13))).rejects.toMatchObject({
		code: "COMMAND_BLOCKED",
	});
	await inputStudioJob(session, jobId, generation, "studio-answer" + String.fromCharCode(13));
	await manager.getJob(jobId)!.promise;
	expect(manager.getJob(jobId)?.resultText).toContain("RECEIVED=studio-answer");
	expect((await inspectStudioJob(session, jobId)).canInput).toBe(false);
	expect(readStudioPtyInputWaits(session)).toEqual([]);
	await expect(inputStudioJob(session, jobId, generation, "late" + String.fromCharCode(13))).rejects.toMatchObject({
		code: "COMMAND_BLOCKED",
	});
}, 15000);

test("BashTool pty runs as an inspectable native job in Studio and accepts user input", async () => {
	const dir = TempDir.createSync("studio-bash-pty-");
	dirs.push(dir);
	const cwd = path.resolve(dir.path()),
		sessionId = cwd;
	const script = path.join(cwd, "prompt.ts");
	await Bun.write(
		script,
		`console.log("ROUTE_READY"); process.stdin.setEncoding("utf8"); process.stdin.on("data", value => { if (String(value).trim()) { console.log("ROUTE_INPUT=" + String(value).trim()); process.exit(0); } });`,
	);
	const manager = new AsyncJobManager({});
	managers.push(manager);
	const toolSession: ToolSession = {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		asyncJobManager: manager,
		settings: Settings.isolated({ "bash.autoBackground.enabled": false }),
	};
	const tool = new BashTool(toolSession);
	const ui = new StudioRemoteExtensionUiContext({} as StudioUiGateway, "pty-route");
	const outputReady = Promise.withResolvers<void>();
	const stop = manager.onJobsChanged(() => {
		if (manager.getRunningJobs().some(job => job.progressText?.includes("ROUTE_READY"))) outputReady.resolve();
	});
	try {
		const command =
			JSON.stringify(process.execPath.replaceAll(String.fromCharCode(92), "/")) +
			" " +
			JSON.stringify(script.replaceAll(String.fromCharCode(92), "/"));
		const result = await tool.execute(
			"pty-route",
			{ command, pty: true, async: true, timeout: 15 },
			undefined,
			undefined,
			{ hasUI: true, ui } as unknown as AgentToolContext,
		);
		const jobId = result.details!.async!.jobId;
		const job = manager.getJob(jobId)!;
		await Promise.race([
			outputReady.promise,
			job.promise.then(() => {
				throw Error(job.errorText ?? job.resultText ?? "PTY exited before prompt");
			}),
		]);
		const session = {
			sessionId,
			asyncJobManager: manager,
			inspectAsyncJob: (id: string) => inspectAsyncJob(manager, "Main", id),
		} as unknown as AgentSession;
		const inspection = await inspectStudioJob(session, jobId);
		expect(inspection.canInput).toBe(true);
		await inputStudioJob(session, jobId, inspection.inputGeneration!, "through-tool" + String.fromCharCode(13));
		await job.promise;
		expect(job.status).toBe("completed");
		expect(job.resultText).toContain("ROUTE_INPUT=through-tool");
	} finally {
		stop();
		releaseShellSessions(sessionId);
	}
}, 25000);
