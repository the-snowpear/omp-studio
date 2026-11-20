import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { listServices, startService } from "../src/launch/services";
import { projectService } from "../src/studio/services/workbench-service";
import type { ToolSession } from "../src/tools";
import { IsolatedDaemon } from "./fixtures/daemon-harness";

test("agent service preview URLs persist on the native unit and project with ownership", async () => {
	const isolated = await IsolatedDaemon.create();
	const session = {
		cwd: isolated.dir,
		settings: Settings.isolated(),
		getSessionId: () => "session-1",
	} as ToolSession;
	try {
		const command = '"' + process.execPath + '" --eval "setInterval(() => {}, 1000)"';
		const previewUrl = "http://127.0.0.1:9733/path";
		const { daemon } = await startService(session, {
			name: "studio-preview",
			command,
			pty: false,
			previewUrl,
			awaitReady: false,
		});
		isolated.track(...daemon.pids);
		expect(projectService((await listServices(session))[0]!, "session-1")).toMatchObject({
			name: "studio-preview",
			previewUrl,
			scope: "session",
		});
	} finally {
		await isolated.dispose();
	}
}, 30000);
