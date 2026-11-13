import { describe, expect, it, vi } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../src/launch/broker";
import * as brokerClients from "../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonSnapshot,
} from "../src/launch/protocol";
import { listServices, requestService, startService } from "../src/launch/services";
import { projectService } from "../src/studio/services/workbench-service";
import { validateWorkbenchResult } from "../src/studio/workbench-protocol";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

async function startBroker(projectDir: string, runtimeDir: string): Promise<{ finished: Promise<void> }> {
	const keys = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV];
	const previous = keys.map(key => process.env[key]);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	keys.forEach((key, index) => {
		if (previous[index] === undefined) delete process.env[key];
		else process.env[key] = previous[index];
	});
	if (!(await Promise.race([listening.promise, finished.then(() => false)])))
		throw new Error("Test broker did not claim its temporary scope");
	return { finished };
}

async function withBroker(
	run: (session: ToolSession, restartBroker: () => Promise<void>, runtimeDir: string) => Promise<void>,
): Promise<void> {
	using temp = TempDir.createSync("@omp-studio-service-preview-");
	const projectDir = join(temp.path(), "project");
	const runtimeDir = join(temp.path(), "runtime");
	await mkdir(projectDir);
	let client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5000 });
	const title = process.title;
	let broker = await startBroker(projectDir, runtimeDir);
	const disposers: Array<() => void> = [];
	const session: ToolSession = {
		cwd: projectDir,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "main-session-42",
		getAgentId: () => "Main",
		registerDisposeCallback: callback => {
			disposers.push(callback);
		},
	};
	const stopBroker = async (): Promise<void> => {
		for (const dispose of disposers.splice(0)) dispose();
		await client.request({ op: "shutdown" });
		client.close();
		await broker.finished;
	};
	try {
		vi.spyOn(brokerClients, "daemonClientForProject").mockImplementation(async () => client);
		await run(
			session,
			async () => {
				await stopBroker();
				client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5000 });
				broker = await startBroker(projectDir, runtimeDir);
			},
			runtimeDir,
		);
	} finally {
		vi.restoreAllMocks();
		await stopBroker();
		process.title = title;
	}
}

const command = "echo studio-ready; read answer";
const ready = { log: "studio-ready", timeout: 5 };

function expectPreview(daemon: DaemonSnapshot, previewUrl: string): void {
	expect(daemon.previewUrl).toBe(previewUrl);
	expect(daemon.owner).toBe("main-session-42");
	expect(projectService(daemon)).toMatchObject({
		previewUrl,
		ownerId: "main-session-42",
		ownerAgentId: "main-session-42",
	});
	// The projected row must also pass the result contract the dispatcher
	// enforces; an unlisted field fails every services.list poll.
	expect(() =>
		validateWorkbenchResult("services.list", { enabled: true, services: [projectService(daemon)] }),
	).not.toThrow();
}

describe("Studio Agent-created service previews", () => {
	it("carries bash preview metadata through broker reads, restart, and persisted recovery", async () => {
		await withBroker(async (session, restartBroker, runtimeDir) => {
			const shell = session.settings.getShellConfig();
			vi.spyOn(session.settings, "getShellConfig").mockReturnValue({
				...shell,
				env: { ...shell.env, STUDIO_TEST_SERVICE_SECRET: "never-publish-env" },
			});
			const previewUrl = "http://localhost:4100/?view=main";
			const tool = await new BashTool(session).execute("main-start-dev", {
				command: `${command} # never-publish-command`,
				name: "web-dev",
				previewUrl: "HTTP://LOCALHOST:4100/app/../?view=main",
				pty: false,
				ready,
			});
			expect(tool.details?.service).toMatchObject({ name: "web-dev", ready: true, timedOut: false });
			const listed = (await listServices(session))[0]!;
			expectPreview(listed, previewUrl);
			expect(listed.pid).toBeGreaterThan(0);
			const row = projectService(listed);
			expect(row.pid).toBe(listed.pid);
			for (const field of ["env", "command", "args", "application", "spec"]) expect(row).not.toHaveProperty(field);
			expect(JSON.stringify(row)).not.toContain("never-publish");
			const described = await requestService(session, { op: "describe", name: "web-dev" });
			if (described.op !== "describe") throw new Error("Expected describe");
			expectPreview(described.daemon, previewUrl);
			expect(described.spec.previewUrl).toBe(previewUrl);
			expect(projectService(described.daemon).instanceId).toBe(row.instanceId);
			const restarted = await requestService(session, {
				op: "restart",
				name: "web-dev",
				expectedInstanceId: row.instanceId,
			});
			if (restarted.op !== "restart") throw new Error("Expected restart");
			expectPreview(restarted.daemon, previewUrl);
			expect(restarted.daemon.pid).toBeGreaterThan(0);
			const nextId = projectService(restarted.daemon).instanceId;
			expect(nextId).not.toBe(row.instanceId);
			const waited = await requestService(session, { op: "wait", name: "web-dev", for: "ready", timeoutMs: 5000 });
			if (waited.op !== "wait") throw new Error("Expected readiness wait");
			expect(waited.timedOut).toBe(false);
			expectPreview(waited.daemon, previewUrl);
			expect(projectService((await listServices(session))[0]!).instanceId).toBe(nextId);
			await restartBroker();
			const recovered = await requestService(session, { op: "describe", name: "web-dev" });
			if (recovered.op !== "describe") throw new Error("Expected recovered describe");
			expectPreview(recovered.daemon, previewUrl);
			expect(recovered.spec.previewUrl).toBe(previewUrl);
			expect(projectService(recovered.daemon).instanceId).toBe(nextId);
			expectPreview((await listServices(session))[0]!, previewUrl);
			expect(await Bun.file(join(runtimeDir, "daemons", "web-dev", "spec.json")).json()).toMatchObject({
				previewUrl,
			});
			expect((await Bun.file(join(runtimeDir, "daemons", "web-dev", "meta.json")).json()).daemon).toMatchObject({
				previewUrl,
				owner: "main-session-42",
			});
			const https = await startService(session, {
				name: "web-dev",
				command,
				ready,
				pty: false,
				previewUrl: "HTTPS://LOCALHOST:4443",
			});
			expectPreview(https.daemon, "https://localhost:4443/");
		});
	}, 30000);

	it("leaves non-web previews absent and preserves legacy or missing owners without guessing", async () => {
		await withBroker(async session => {
			// A URL in a name, command, or readiness output is not preview metadata.
			const tool = await new BashTool(session).execute("main-start-worker", {
				command: "echo http://localhost:4200; read answer",
				name: "localhost-4200",
				pty: false,
				ready: { log: "http://localhost:4200", timeout: 5 },
			});
			expect(tool.details?.service?.ready).toBe(true);
			const listed = (await listServices(session))[0]!;
			expect(listed).not.toHaveProperty("previewUrl");
			expect(projectService(listed)).not.toHaveProperty("previewUrl");
			const described = await requestService(session, { op: "describe", name: listed.name });
			if (described.op !== "describe") throw new Error("Expected describe");
			expect(described.spec).not.toHaveProperty("previewUrl");
			expect(described.daemon).not.toHaveProperty("previewUrl");
			const legacy = await startService(
				{ ...session, getSessionId: () => null },
				{
					name: "legacy-worker",
					command,
					ready,
					pty: false,
				},
			);
			expect(projectService(legacy.daemon)).toMatchObject({ ownerId: "Main", ownerAgentId: "Main" });
			const unowned = await startService(
				{ ...session, getSessionId: undefined, getAgentId: undefined },
				{
					name: "unowned-worker",
					command,
					ready,
					pty: false,
				},
			);
			expect(projectService(unowned.daemon)).not.toHaveProperty("ownerId");
			expect(projectService(unowned.daemon)).not.toHaveProperty("ownerAgentId");
		});
	}, 20000);

	it("refuses preview starts against a resident old broker without replacing its services", async () => {
		await withBroker(async session => {
			const existing = await startService(session, { name: "server", command, ready, pty: false });
			const instanceId = projectService(existing.daemon).instanceId;
			const client = await brokerClients.daemonClientForProject(session.cwd);
			const request = client.request.bind(client);
			// Model an older broker that still supports instance fencing, but would
			// silently discard previewUrl if the new Agent sent it a start request.
			const requests = vi.spyOn(client, "request").mockImplementation(async (operation, signal) => {
				if (operation.op === "ping") return { op: "ping", projectDir: session.cwd, instanceFencing: true };
				return request(operation, signal);
			});
			for (const name of ["new-server", "server"]) {
				await expect(
					new BashTool(session).execute("old-broker-preview", {
						command,
						name,
						previewUrl: "http://localhost:4100",
						pty: false,
					}),
				).rejects.toThrow("This project broker does not support preview URLs");
			}
			expect(requests.mock.calls.map(([operation]) => operation.op)).toEqual(["ping", "ping"]);
			const listed = await listServices(session);
			expect(listed).toHaveLength(1);
			expect(projectService(listed[0]!).instanceId).toBe(instanceId);
			expect(listed[0]!.state).toBe("ready");
			// Services without preview metadata remain compatible with older brokers.
			const ordinary = await startService(session, { name: "worker", command, ready, pty: false });
			expect(ordinary.daemon.state).toBe("ready");
			expect(ordinary.daemon).not.toHaveProperty("previewUrl");
		});
	}, 20000);

	it("rejects invalid preview URLs before launching or replacing an existing service", async () => {
		await withBroker(async session => {
			const existing = await startService(session, { name: "server", command, ready, pty: false });
			const instanceId = projectService(existing.daemon).instanceId;
			for (const previewUrl of [
				"not a URL",
				"/relative",
				"file:///tmp/index.html",
				"http://user:secret@localhost:4100",
				"",
			]) {
				const attempt = new BashTool(session).execute("invalid-preview", {
					command,
					name: "server",
					previewUrl,
					pty: false,
				});
				await expect(attempt).rejects.toThrow(
					"previewUrl must be an absolute HTTP(S) URL without embedded credentials",
				);
			}
			const listed = await listServices(session);
			expect(listed).toHaveLength(1);
			expect(projectService(listed[0]!).instanceId).toBe(instanceId);
			expect(listed[0]!.state).toBe("ready");
		});
	}, 20000);
});
