import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../src/launch/broker";
import { createDaemonBrokerClient } from "../src/launch/client";
import { DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV } from "../src/launch/protocol";
import { projectService } from "../src/studio/services/workbench-service";

describe("Studio service instance fencing", () => {
	it("serializes a restart and stale stop without stopping the new process", async () => {
		using temp = TempDir.createSync("@omp-studio-fence-");
		const projectDir = join(temp.path(), "project");
		const runtimeDir = join(temp.path(), "runtime");
		await mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5000 });
		const names = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV];
		const old = names.map(key => process.env[key]);
		const title = process.title;
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
		const broker = startDaemonBrokerFromEnvironment();
		names.forEach((key, index) => {
			if (old[index] === undefined) delete process.env[key];
			else process.env[key] = old[index];
		});
		try {
			const ping = await client.request({ op: "ping" });
			expect(ping.op === "ping" && ping.instanceFencing).toBe(true);
			const started = await client.request({
				op: "start",
				spec: {
					name: "server",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000)"],
					cwd: projectDir,
					env: {},
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("Expected start");
			const expectedInstanceId = projectService(started.daemon).instanceId;
			const restarting = client.request({ op: "restart", name: "server", expectedInstanceId });
			const stale = client
				.request({ op: "stop", name: "server", expectedInstanceId, timeoutMs: 1000 })
				.catch(error => error);
			const restarted = await restarting;
			expect((await stale).message).toContain("instance changed");
			if (restarted.op !== "restart") throw new Error("Expected restart");
			expect(projectService(restarted.daemon).instanceId).not.toBe(expectedInstanceId);
			const list = await client.request({ op: "list" });
			expect(list.op === "list" && list.daemons[0]?.state).toBe("running");
			expect(
				(
					await client
						.request({ op: "send", name: "server", expectedInstanceId, data: "ignored\n" })
						.catch(error => error)
				).message,
			).toContain("instance changed");
			expect(
				(
					await client
						.request({ op: "mode", name: "server", expectedInstanceId, mode: "persist" })
						.catch(error => error)
				).message,
			).toContain("instance changed");
			expect(
				(
					await client
						.request({
							op: "start",
							replace: false,
							spec: {
								name: "server",
								application: process.execPath,
								args: [],
								cwd: projectDir,
								env: {},
								pty: false,
								restart: "no",
								persist: false,
								detached: false,
							},
						})
						.catch(error => error)
				).message,
			).toContain("already");
			const beforeStart = Date.now();
			const starting = await client.request({
				op: "start",
				waitForReady: false,
				spec: {
					name: "readiness",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000)"],
					cwd: projectDir,
					env: {},
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
					ready: { log: "NEVER", timeoutMs: 60000 },
				},
			});
			expect(Date.now() - beforeStart).toBeLessThan(5000);
			if (starting.op !== "start") throw new Error("Expected nonblocking start");
			expect(starting.daemon.state).toBe("starting");
			const stopped = await client.request({
				op: "stop",
				name: "readiness",
				expectedInstanceId: projectService(starting.daemon).instanceId,
				timeoutMs: 1000,
			});
			expect(stopped.op === "stop" && stopped.daemon.state).toBe("exited");
		} finally {
			await client.request({ op: "stop", name: "readiness", timeoutMs: 1000 }).catch(() => {});
			await client.request({ op: "stop", name: "server", timeoutMs: 1000 }).catch(() => {});
			await client.request({ op: "shutdown" }).catch(() => {});
			client.close();
			await broker;
			process.title = title;
		}
	}, 25000);
});
