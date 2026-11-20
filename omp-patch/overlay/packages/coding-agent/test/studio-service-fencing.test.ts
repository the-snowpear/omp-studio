import { expect, test } from "bun:test";
import { daemonClient } from "../src/daemon/client";
import { IsolatedDaemon } from "./fixtures/daemon-harness";

test("a service generation fences restart, input and logs after native restart", async () => {
	const isolated = await IsolatedDaemon.create();
	try {
		const daemon = await daemonClient();
		const { unit } = await daemon.open({
			kind: "proc",
			scope: { kind: "global" },
			key: "studio-fence",
			proc: {
				application: process.execPath,
				args: ["--eval", "setInterval(() => {}, 1000)"],
				env: {},
				cwd: isolated.dir,
				pty: false,
			},
		});
		isolated.track(...unit.pids);
		const current = await daemon.request({ op: "restart", unit: unit.id, generation: unit.generation });
		isolated.track(...current.unit.pids);
		expect(current.unit.generation).not.toBe(unit.generation);
		await expect(daemon.request({ op: "restart", unit: unit.id, generation: unit.generation })).rejects.toThrow(
			"instance changed",
		);
		await expect(
			daemon.request({ op: "send", unit: unit.id, generation: unit.generation, data: "stale" }),
		).rejects.toThrow("instance changed");
		await expect(
			daemon.request({
				op: "logs",
				unit: unit.id,
				generation: unit.generation,
				lines: 5,
				head: false,
				follow: false,
				timeoutMs: 1000,
			}),
		).rejects.toThrow("instance changed");
	} finally {
		await isolated.dispose();
	}
}, 30000);
