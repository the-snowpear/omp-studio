import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../src/session/agent-session";
import { Settings } from "../src/config/settings";
import { startRelayServer } from "../src/tools/browser/relay/server";
import { StudioChromeRelayHostService } from "../src/studio/services/chrome-relay-host-service";
import type { ChromeRelayHostEnvironment } from "../src/studio/services/chrome-relay-host-service";
import { extensionIdForPath } from "../src/tools/browser/relay/extension-files";
import { unregisterUnpackedExtensions } from "../src/tools/browser/relay/chrome/secure-store";
import type { ChromiumBrowser } from "../src/tools/browser/relay/chromium-profiles";
import { VERSION } from "@oh-my-pi/pi-utils";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function harness(extra: ChromeRelayHostEnvironment = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-relay-host-"));
	roots.push(root);
	const registryFile = path.join(root, "relay", "installs.json");
	const defaultDir = path.join(root, "relay", "extension");
	const values = new Map<string, string>();
	const env: ChromeRelayHostEnvironment = {
		locations: { platform: "win32", home: root, localAppData: path.join(root, "local") },
		installLocations: { registryFile, defaultDir, relayUrl: null },
		hostDir: path.join(root, "relay"),
		command: [path.join(root, "omp.exe")],
		findInstalledBrowsers: async () => [],
		runRegistry: async args => {
			const key = args[1]!;
			if (args[0] === "add") {
				values.set(key, args[args.indexOf("/d") + 1]!);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "delete") {
				values.delete(key);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return values.has(key)
				? { exitCode: 0, stdout: `    (Default)    REG_SZ    ${values.get(key)}`, stderr: "" }
				: { exitCode: 1, stdout: "", stderr: "" };
		},
		probeRelay: async () => null,
		...extra,
	};
	const service = new StudioChromeRelayHostService({ sessionId: "relay-chat" } as AgentSession, env);
	return { root, defaultDir, registryFile, env, service, values };
}

test("install, stale-build sync and repair create usable native manifests; uninstall preserves unrelated files", async () => {
	const h = await harness();
	const installed = await h.service.install({ registerChrome: false });
	expect(installed.status.nativeHost.registered).toBe(true);
	expect(installed.status.installs[0]?.upToDate).toBe(true);
	const manifest = await Bun.file(installed.manifestPaths[0]!).json();
	expect(manifest.allowed_origins).toContain(`chrome-extension://${installed.extensionId}/`);
	expect(await Bun.file(manifest.path).text()).toContain('"browser-relay" "native-host"');

	const extensionManifest = path.join(h.defaultDir, "manifest.json");
	const oldManifest = await Bun.file(extensionManifest).json();
	await Bun.write(extensionManifest, JSON.stringify({ ...oldManifest, version_name: "18.0.0" }));
	expect((await h.service.getStatus({ probeHealth: false })).installs[0]?.upToDate).toBe(false);
	const synced = await h.service.sync();
	expect(synced.results[0]?.status).toBe("written");
	expect(synced.status.installs[0]?.installedVersion).toBe(VERSION);

	await Bun.write(installed.manifestPaths[0]!, "{}");
	expect((await h.service.getStatus({ probeHealth: false })).nativeHost.needsRepair).toBe(true);
	const repaired = await h.service.repair({ repairProfile: false });
	expect(repaired.status.nativeHost.registered).toBe(true);
	await Bun.write(manifest.path, '@echo off\r\n"C:\\obsolete\\omp.exe" "browser-relay" "native-host"\r\n');
	expect((await h.service.getStatus({ probeHealth: false })).nativeHost.launcherValid).toBe(false);
	expect((await h.service.repair({ repairProfile: false })).status.nativeHost.launcherValid).toBe(true);

	await Bun.write(path.join(h.defaultDir, "personal-notes.txt"), "keep me");
	const uninstalled = await h.service.uninstall({ removeProfileRegistrations: false, removeExtensionFiles: true });
	expect(uninstalled.status.nativeHost.registered).toBe(false);
	expect(await Bun.file(extensionManifest).exists()).toBe(false);
	expect(await Bun.file(path.join(h.defaultDir, "personal-notes.txt")).text()).toBe("keep me");
	expect(h.values.size).toBe(0);
});

test("a specifically selected profile installs even when another profile already loads the extension", async () => {
	const calls: Array<{ browser?: string; profile?: string }> = [];
	const h = await harness({
		installInChrome: async options => {
			calls.push(options);
			return [];
		},
	});
	await h.service.install({ registerChrome: false });
	const userData = path.join(h.root, "local", "Google", "Chrome", "User Data");
	const id = extensionIdForPath(h.defaultDir);
	await Bun.write(
		path.join(userData, "Local State"),
		JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } } } }),
	);
	await Bun.write(
		path.join(userData, "Default", "Preferences"),
		JSON.stringify({ extensions: { settings: { [id]: { location: 4, state: 1 } } } }),
	);
	await Bun.write(path.join(userData, "Profile 1", "Preferences"), "{}");
	await h.service.install({ browser: "Google Chrome", profile: "Profile 1", registerChrome: true });
	expect(calls).toHaveLength(1);
	expect(calls[0]?.profile).toBe("Profile 1");
	const status = await h.service.getStatus({ probeHealth: false });
	expect(status.profiles.find(row => row.profileDir === "Default")?.enabled).toBe(true);
	expect(status.profiles.find(row => row.profileDir === "Profile 1")?.loaded).toBe(false);
});

test("enterprise policy reports exact Native Messaging refusal while respecting allowlists", async () => {
	const h = await harness({
		runRegistry: async args => {
			const key = args[1]!;
			if (key === "HKLM\\Software\\Policies\\Google\\Chrome\\NativeMessagingBlocklist")
				return { exitCode: 0, stdout: "    1    REG_SZ    *", stderr: "" };
			if (key === "HKLM\\Software\\Policies\\Google\\Chrome" && args[3] === "NativeMessagingUserLevelHosts")
				return { exitCode: 0, stdout: "    NativeMessagingUserLevelHosts    REG_DWORD    0x0", stderr: "" };
			if (key === "HKLM\\Software\\Policies\\Microsoft\\Edge\\NativeMessagingBlocklist")
				return { exitCode: 0, stdout: "    1    REG_SZ    *", stderr: "" };
			if (key === "HKLM\\Software\\Policies\\Microsoft\\Edge\\NativeMessagingAllowlist")
				return { exitCode: 0, stdout: "    1    REG_SZ    sh.omp.browser", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		},
	});
	const { policy } = await h.service.getStatus({ probeHealth: false });
	expect(policy.nativeHostBlocked).toBe(true);
	expect(policy.userLevelHostsDisabled).toBe(true);
	expect(policy.denials.map(row => row.policy)).toEqual(["NativeMessagingBlocklist", "NativeMessagingUserLevelHosts"]);
	expect(policy.denials.every(row => row.browser === "Google Chrome" && row.source.startsWith("HKLM"))).toBe(true);
});

test("profile unregister removes only unpacked relay records and leaves a restorable backup", async () => {
	const h = await harness();
	const profileDir = path.join(h.root, "profile");
	const prefs = {
		extensions: {
			settings: { relay: { location: 4, path: "relay" }, store: { location: 1 }, unrelated: { location: 4 } },
		},
	};
	await Bun.write(path.join(profileDir, "Preferences"), JSON.stringify(prefs));
	const browser = {
		name: "Chrome",
		dir: h.root,
		executable: "chrome",
		keychain: "Chrome Safe Storage",
		resourceDirs: [],
	} satisfies ChromiumBrowser;
	expect(await unregisterUnpackedExtensions(browser, profileDir, new Set(["relay", "store"]))).toEqual(["relay"]);
	const changed = await Bun.file(path.join(profileDir, "Preferences")).json();
	expect(Object.keys(changed.extensions.settings)).toEqual(["store", "unrelated"]);
	expect(await Bun.file(path.join(profileDir, "Preferences.omp-backup")).json()).toEqual(prefs);
});

test("health follows a real upstream relay from waiting for extension to ready", async () => {
	const relay = startRelayServer({ port: 0, group: false });
	const url = `http://127.0.0.1:${relay.port}`;
	const h = await harness();
	const settings = Settings.isolated({ "browser.relay": true, "browser.relayUrl": url });
	const env = { ...h.env };
	delete env.probeRelay;
	const service = new StudioChromeRelayHostService({ sessionId: "relay-chat", settings } as AgentSession, env);
	let extension: WebSocket | undefined;
	try {
		const before = await service.getStatus();
		expect(before.health.endpoints.find(endpoint => endpoint.url === url)?.outcome).toBe("no-extension");
		extension = new WebSocket(`${url.replace("http:", "ws:")}/ext`);
		const opened = Promise.withResolvers<void>();
		extension.addEventListener("open", () => opened.resolve(), { once: true });
		extension.addEventListener("error", () => opened.reject(new Error("Extension connection failed")), {
			once: true,
		});
		await opened.promise;
		extension.send(
			JSON.stringify({
				t: "hello",
				userAgent: "Chrome test",
				browserVersion: "Chrome/151.0.0.0",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		const deadline = Date.now() + 1000;
		while (!relay.bridge.ready && Date.now() < deadline) await Bun.sleep(5);
		const ready = await service.getStatus();
		expect(ready.health.ready).toBe(true);
		expect(ready.health.endpoints.find(endpoint => endpoint.url === url)).toMatchObject({
			configured: true,
			outcome: "ready",
			relayVersion: VERSION,
			cdpClients: 0,
		});
	} finally {
		extension?.close();
		relay.stop();
	}
});
