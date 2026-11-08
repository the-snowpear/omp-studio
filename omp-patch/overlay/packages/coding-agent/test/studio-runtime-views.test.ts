import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { RunTrace } from "@oh-my-pi/pi-natives";
import { defaultShellVizPreferences } from "@oh-my-pi/pi-tui/tools/shell-viz";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { CURRENT_SESSION_VERSION } from "../src/session/session-entries";
import * as loader from "../src/session/session-loader";
import { StudioLiveAudioService } from "../src/studio/services/live-audio-service";
import { StudioRuntimeViews } from "../src/studio/services/runtime-view-service";
import type { RuntimeViewResultMap } from "../src/studio/runtime-views-protocol";

afterEach(() => mock.restore());

test("replays a persisted command missing from active context with one journal load until the view closes", async () => {
	const file = join(tmpdir(), `studio-shell-review-${randomUUID()}.jsonl`);
	const trace = JSON.parse(new RunTrace("printf 'recorded\\n'").snapshot());
	await writeFile(
		file,
		[
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "live",
				cwd: tmpdir(),
				timestamp: new Date().toISOString(),
			},
			{
				type: "message",
				id: "tool",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "shell",
					toolName: "bash",
					content: [{ type: "text", text: "recorded" }],
					isError: false,
					timestamp: Date.now(),
					details: { trace },
				},
			},
		]
			.map(row => JSON.stringify(row))
			.join("\n") + "\n",
	);
	const session = {
		sessionId: "live",
		settings: Settings.isolated({ "display.shellVisualization": true }),
		sessionManager: { getSessionId: () => "live", getSessionFile: () => file },
		messages: [{ role: "user", content: "After compaction", timestamp: Date.now() }],
		activeToolExecutionUpdates: () => [],
	} as unknown as AgentSession;
	const audio = new StudioLiveAudioService(session),
		views = new StudioRuntimeViews(session, audio);
	const reads = spyOn(loader, "loadEntriesFromFile");
	const input = { sessionId: "live", toolCallId: "shell" };
	try {
		const frames = (await Promise.all(
			[0, 1, 2].map(cursor =>
				views.execute({
					kind: "shell.view.read",
					...input,
					preferences: { ...defaultShellVizPreferences(), view: "raw", cursor },
				}),
			),
		)) as RuntimeViewResultMap["shell.view.read"][];
		expect(frames.every(frame => frame.available && frame.presentation?.preferences.view === "raw")).toBe(true);
		expect(reads).toHaveBeenCalledTimes(1);
		await views.execute({ kind: "shell.view.release", ...input });
		expect(
			((await views.execute({ kind: "shell.view.read", ...input })) as RuntimeViewResultMap["shell.view.read"])
				.available,
		).toBe(true);
		expect(reads).toHaveBeenCalledTimes(2);
	} finally {
		audio.dispose();
		await unlink(file);
	}
});
