import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { takeStudioParentPid, watchStudioParent } from "@oh-my-pi/pi-coding-agent/studio/parent-watchdog";
import { workspacePathKey } from "@oh-my-pi/pi-coding-agent/studio/session-telemetry-probe";
import { runStudioHostMode } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

function manualClock() {
	let tick: (() => void) | undefined;
	let cancelled = 0;
	return {
		setInterval: (callback: () => void) => {
			tick = callback;
			return 1;
		},
		clearInterval: () => {
			cancelled++;
		},
		tick: () => tick?.(),
		cancelled: () => cancelled,
	};
}

test("the Host pid leaves the environment, and a malformed value is ignored", () => {
	const env: NodeJS.ProcessEnv = { OMP_STUDIO_PARENT_PID: "4242" };
	expect(takeStudioParentPid(env)).toBe(4242);
	expect("OMP_STUDIO_PARENT_PID" in env).toBe(false);
	for (const raw of ["0", "-1", "12ab", "", "99999999999"]) {
		const malformed: NodeJS.ProcessEnv = { OMP_STUDIO_PARENT_PID: raw };
		expect(takeStudioParentPid(malformed)).toBeUndefined();
		expect("OMP_STUDIO_PARENT_PID" in malformed).toBe(false);
	}
});

test("adoption or a vanished Host pid ends the Runtime exactly once", () => {
	for (const loss of ["adopted", "vanished"] as const) {
		const clock = manualClock();
		let parent = 100;
		let alive = true;
		let lost = 0;
		watchStudioParent({
			parentPid: 100,
			onLost: () => lost++,
			currentParentPid: () => parent,
			isAlive: () => alive,
			...clock,
		});
		clock.tick();
		expect(lost).toBe(0);
		if (loss === "adopted") parent = 1;
		else alive = false;
		clock.tick();
		clock.tick();
		expect(lost).toBe(1);
		expect(clock.cancelled()).toBe(1);
	}
});

test("a stopped watchdog never reports a late loss", () => {
	const clock = manualClock();
	let lost = 0;
	const stop = watchStudioParent({ parentPid: 100, onLost: () => lost++, isAlive: () => false, ...clock });
	stop();
	clock.tick();
	expect(lost).toBe(0);
});

test.skipIf(process.platform === "win32")(
	"a watcher whose Host is killed exits within seconds",
	async () => {
		const modulePath = path.join(import.meta.dir, "..", "src", "studio", "parent-watchdog.ts");
		const script = `import { watchStudioParent } from ${JSON.stringify(modulePath)}; watchStudioParent({ parentPid: Number(process.env.HOST_PID), onLost: () => process.exit(0) }); setInterval(() => {}, 1000); console.log("ready");`;
		// `sh` plays the Host: it starts the watcher, reports its pid and then dies without cleanup.
		const host = Bun.spawn(["/bin/sh", "-c", `HOST_PID=$$ "$0" -e "$1" & echo $!; wait`, process.execPath, script], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = (host.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let output = "";
		while (!/^ready$/m.test(output) || !/^\d+$/m.test(output)) {
			const { value, done } = await reader.read();
			if (done) break;
			output += decoder.decode(value);
		}
		reader.releaseLock();
		const watcher = Number(/^(\d+)$/m.exec(output)?.[1]);
		expect(Number.isSafeInteger(watcher) && watcher > 0).toBe(true);
		expect(output).toContain("ready");
		host.kill("SIGKILL");
		await host.exited;
		const deadline = Date.now() + 5_000;
		let running = true;
		while (running && Date.now() < deadline) {
			try {
				process.kill(watcher, 0);
				await Bun.sleep(50);
			} catch {
				running = false;
			}
		}
		if (running) process.kill(watcher, "SIGKILL");
		expect(running).toBe(false);
	},
	15_000,
);

test("losing the Host aborts the turn and shuts down without draining", async () => {
	const aborts: unknown[] = [];
	const session = {
		sessionManager: {
			getSessionId: () => "session-test",
			getCwd: () => process.cwd(),
			getSessionFile: () => null,
			ensureOnDisk: async () => {},
			flush: async () => {},
		},
		settings: { get: (key: string) => (key === "loop.mode" ? "prompt" : undefined) },
		isStreaming: true,
		isCompacting: false,
		hasPostPromptWork: false,
		getVibeModeState: () => undefined,
		prompt: async () => {},
		compact: async () => {},
		resetSessionContext: async () => {},
		abort: async (options: unknown) => {
			aborts.push(options);
		},
		// A drain would wait for this turn forever.
		waitForIdle: () => new Promise<void>(() => {}),
		ensureOnDisk: async () => {},
		flush: async () => {},
		dispose: async () => {},
		subscribe: () => () => {},
		setBeforeNextUserTurn: () => {},
		registerSessionChangeCallback: () => () => {},
	} as unknown as AgentSession;
	let loseHost: (() => void) | undefined;
	let watching = false;
	const exits: number[] = [];
	await runStudioHostMode(
		session,
		{ runtimeEpoch: 1 },
		async runtime => {
			loseHost?.();
			await runtime.waitForShutdown();
		},
		{
			createBridge: () => ({ async start() {}, async stop() {} }),
			watchParent: onLost => {
				watching = true;
				loseHost = onLost;
				return () => {
					watching = false;
				};
			},
			hostLossExit: { delayMs: 60_000, exit: code => exits.push(code) },
		},
	);
	expect(aborts).toEqual([{ goalReason: "internal", reason: "OMP Studio exited" }]);
	expect(watching).toBe(false);
	expect(exits).toEqual([]);
});

test("the telemetry probe matches workspaces with the Host's path rule", () => {
	expect(workspacePathKey("/private/var/folders/ab/T/proj", "darwin")).toBe(
		workspacePathKey("/var/folders/ab/T/proj/", "darwin"),
	);
	expect(workspacePathKey("/Users/dev/Caf\u00e9", "darwin")).toBe(workspacePathKey("/Users/dev/Cafe\u0301", "darwin"));
	expect(workspacePathKey("/private/varnish/proj", "darwin")).toBe("/private/varnish/proj");
	expect(workspacePathKey("/Users/dev/Proj", "darwin")).not.toBe(workspacePathKey("/Users/dev/proj", "darwin"));
	expect(workspacePathKey("C:\\Work\\Proj", "win32")).toBe(workspacePathKey("c:\\work\\proj\\", "win32"));
	expect(workspacePathKey("/private/tmp/proj", "linux")).not.toBe(workspacePathKey("/tmp/proj", "linux"));
});
