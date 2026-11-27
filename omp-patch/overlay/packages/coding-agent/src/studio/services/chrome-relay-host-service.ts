import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBrowserRelayInstallRegistryFile, isEnoent, isRecord, VERSION } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { resolveCliEntryCmd } from "../../subprocess/worker-client";
import { probeCdpResponse } from "../../tools/browser/attach";
import { discoverRelayEndpoints } from "../../tools/browser/relay/discovery";
import { embeddedRelayExtensionBuild } from "../../tools/browser/relay/embedded-extension";
import {
	defaultRelayExtensionDir,
	extensionIdForPath,
	installedRelayExtensionStamp,
	installedRelayExtensionVersion,
	loadRelayExtension,
	unpackedExtensionId,
} from "../../tools/browser/relay/extension-files";
import {
	installRelayExtension,
	readRelayInstallRegistry,
	readRelayInstalls,
	registeredRelayExtensionIds,
	type RelayInstallLocations,
	type RelayInstallSyncResult,
	syncRelayInstalls,
} from "../../tools/browser/relay/installs";
import {
	refreshRelayNativeHost,
	relayNativeHostLauncherText,
	registerRelayNativeHost,
	type RelayNativeHostOptions,
	writeRelayNativeHost,
} from "../../tools/browser/relay/native-host-manifest";
import { relayCdpClientsOf, relayVersionOf, requestRelayRestart } from "../../tools/browser/relay/probe";
import { DISCARDED_TABS_PROTOCOL_VERSION, isOlderOmpVersion, NATIVE_HOST } from "../../tools/browser/relay/protocol";
import {
	type ChromiumBrowser,
	type ChromiumLocations,
	type ChromiumProfileInstall,
	chromiumUserDataDirs,
	findUnpackedInstalls,
	installedChromiumBrowsers,
	lastUsedProfile,
	startBrowser,
	stopBrowser,
} from "../../tools/browser/relay/chromium-profiles";
import { installRelayInChrome } from "../../tools/browser/relay/chrome/install";
import { unregisterUnpackedExtensions } from "../../tools/browser/relay/chrome/secure-store";
import { runtimeText } from "../locale";
import { cfgBrowserRelay, cfgBrowserRelayUrl } from "../../tools/browser/settings";
import type {
	ChromeRelayBrowserRow,
	ChromeRelayEndpointHealth,
	ChromeRelayExtensionInstallRow,
	ChromeRelayHealthStatus,
	ChromeRelayHostInstallResult,
	ChromeRelayHostOperation,
	ChromeRelayHostRepairResult,
	ChromeRelayHostStatus,
	ChromeRelayHostSyncItem,
	ChromeRelayHostSyncResult,
	ChromeRelayHostUninstallResult,
	ChromeRelayHostUpdateResult,
	ChromeRelayNativeHostManifestRow,
	ChromeRelayNativeHostStatus,
	ChromeRelayPolicyDenial,
	ChromeRelayPolicyStatus,
	ChromeRelayProfileInstallReport,
	ChromeRelayProfileRow,
	ChromeRelayWindowsRegistryEntry,
} from "../chrome-relay-host-protocol";
import { SessionControlError } from "./session-control-service";

interface CommandOutput {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ChromeRelayHostEnvironment {
	locations?: ChromiumLocations;
	installLocations?: RelayInstallLocations;
	hostDir?: string;
	command?: readonly string[];
	probeTimeoutMs?: number;
	runRegistry?: (args: readonly string[]) => Promise<CommandOutput>;
	runPlutil?: (filePath: string) => Promise<CommandOutput>;
	linuxPolicyDirs?: ReadonlyArray<{ browser: string; dir: string }>;
	macManagedPolicyDirs?: readonly string[];
	installInChrome?: typeof installRelayInChrome;
	findInstalledBrowsers?: (locations?: ChromiumLocations) => Promise<ChromiumBrowser[]>;
	stopBrowser?: typeof stopBrowser;
	startBrowser?: typeof startBrowser;
	probeRelay?: (url: string, options: { timeoutMs: number }) => Promise<{ status: number; body: string } | null>;
	restartRelay?: typeof requestRelayRestart;
}

const WIN_POLICY_TARGETS: ReadonlyArray<{ browser: string; subkey: string }> = [
	{ browser: "Google Chrome", subkey: "Software\\Policies\\Google\\Chrome" },
	{ browser: "Microsoft Edge", subkey: "Software\\Policies\\Microsoft\\Edge" },
	{ browser: "Chromium", subkey: "Software\\Policies\\Chromium" },
];

const WIN_NATIVE_HOST_KEYS: ReadonlyArray<{ browser: string; key: string }> = [
	{ browser: "Google Chrome", key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}` },
	{ browser: "Microsoft Edge", key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST}` },
	{ browser: "Chromium", key: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST}` },
	{
		browser: "Brave",
		key: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST}`,
	},
];

const MAC_POLICY_TARGETS: ReadonlyArray<{ browser: string; bundleId: string }> = [
	{ browser: "Google Chrome", bundleId: "com.google.Chrome" },
	{ browser: "Google Chrome Beta", bundleId: "com.google.Chrome.beta" },
	{ browser: "Google Chrome Dev", bundleId: "com.google.Chrome.dev" },
	{ browser: "Google Chrome Canary", bundleId: "com.google.Chrome.canary" },
	{ browser: "Microsoft Edge", bundleId: "com.microsoft.Edge" },
	{ browser: "Chromium", bundleId: "org.chromium.Chromium" },
];

const LINUX_POLICY_DIRS: ReadonlyArray<{ browser: string; dir: string }> = [
	{ browser: "Google Chrome", dir: "/etc/opt/chrome/policies/managed" },
	{ browser: "Chromium", dir: "/etc/chromium/policies/managed" },
	{ browser: "Chromium", dir: "/etc/chromium-browser/policies/managed" },
	{ browser: "Microsoft Edge", dir: "/etc/opt/edge/policies/managed" },
];

const UNPACKED_LOCATION = 4;

async function defaultRunRegistry(args: readonly string[]): Promise<CommandOutput> {
	const proc = Bun.spawn(["reg.exe", ...args], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function defaultRunPlutil(filePath: string): Promise<CommandOutput> {
	const proc = Bun.spawn(["plutil", "-convert", "json", "-o", "-", filePath], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function readJsonSafe(file: string): Promise<unknown> {
	try {
		return await Bun.file(file).json();
	} catch {
		return undefined;
	}
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
	const left = path.resolve(a);
	const right = path.resolve(b);
	return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value))
		return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

function parseRegList(stdout: string): string[] {
	const entries: string[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const match = /^\s*\S+\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.+?)\s*$/u.exec(line);
		if (!match) continue;
		const value = match[1]!.trim();
		if (value) entries.push(value);
	}
	return entries;
}

function parseRegDword(stdout: string, valueName: string): number | undefined {
	const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`${escaped}\\s+REG_DWORD\\s+(0x[0-9a-f]+|\\d+)`, "iu").exec(stdout);
	if (!match) return undefined;
	const raw = match[1]!;
	const parsed = raw.toLowerCase().startsWith("0x") ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRegDefaultSz(stdout: string): string | undefined {
	for (const line of stdout.split(/\r?\n/u)) {
		const match = /^\s*(?:\(Default\)|\(默认\))\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/iu.exec(line);
		if (match) return match[1]!.trim();
	}
	return undefined;
}

function evaluatePolicyRecord(
	record: Record<string, unknown>,
	context: {
		browser: string;
		scope: "machine" | "user" | "managed";
		source: string;
		extensionIds: readonly string[];
	},
	denials: ChromeRelayPolicyDenial[],
): void {
	const extBlock = stringList(record.ExtensionInstallBlocklist);
	const extAllow = new Set(stringList(record.ExtensionInstallAllowlist));
	const wildcardExtBlocked = extBlock.includes("*") && !extAllow.has("*");
	const matchedBlockedExts = context.extensionIds.filter(
		id => (wildcardExtBlocked && !extAllow.has(id)) || (extBlock.includes(id) && !extAllow.has(id)),
	);
	if (matchedBlockedExts.length > 0 || (wildcardExtBlocked && context.extensionIds.length === 0)) {
		const targetDesc = matchedBlockedExts.length > 0 ? matchedBlockedExts.join(", ") : "unpacked extensions";
		denials.push({
			browser: context.browser,
			policy: "ExtensionInstallBlocklist",
			scope: context.scope,
			source: context.source,
			value: extBlock,
			reason: runtimeText(
				`${context.browser} 的 ExtensionInstallBlocklist 策略阻止 ${targetDesc}（${context.source}）。`,
				`${context.browser} ${context.scope} policy ExtensionInstallBlocklist blocks ${targetDesc} (${context.source}).`,
			),
		});
	}

	const hostBlock = stringList(record.NativeMessagingBlocklist);
	const hostAllow = new Set(stringList(record.NativeMessagingAllowlist));
	const hostWildcardBlocked = hostBlock.includes("*") && !hostAllow.has("*") && !hostAllow.has(NATIVE_HOST);
	const hostExplicitBlocked = hostBlock.includes(NATIVE_HOST) && !hostAllow.has(NATIVE_HOST);
	if (hostWildcardBlocked || hostExplicitBlocked) {
		denials.push({
			browser: context.browser,
			policy: "NativeMessagingBlocklist",
			scope: context.scope,
			source: context.source,
			value: hostBlock,
			reason: runtimeText(
				`${context.browser} 的 NativeMessagingBlocklist 策略拒绝 Native Host "${NATIVE_HOST}"（${context.source}）。`,
				`${context.browser} ${context.scope} policy NativeMessagingBlocklist denies Native Messaging host "${NATIVE_HOST}" (${context.source}).`,
			),
		});
	}

	const userLevelHosts = record.NativeMessagingUserLevelHosts;
	if (userLevelHosts === false || userLevelHosts === 0) {
		denials.push({
			browser: context.browser,
			policy: "NativeMessagingUserLevelHosts",
			scope: context.scope,
			source: context.source,
			value: userLevelHosts,
			reason: runtimeText(
				`${context.browser} 的 NativeMessagingUserLevelHosts 为 0，拒绝用户级 Native Host "${NATIVE_HOST}"（${context.source}）。`,
				`${context.browser} ${context.scope} policy NativeMessagingUserLevelHosts is disabled (0), blocking user-level Native Messaging host "${NATIVE_HOST}" (${context.source}).`,
			),
		});
	}
}

/** Studio management surface for the external Chrome extension & Native Messaging host (`sh.omp.browser`). */
export class StudioChromeRelayHostService {
	readonly #env: ChromeRelayHostEnvironment;

	constructor(
		readonly session: AgentSession,
		env: ChromeRelayHostEnvironment = {},
	) {
		this.#env = env;
	}

	#platform(): NodeJS.Platform {
		return this.#env.locations?.platform ?? process.platform;
	}

	#installLocations(): Required<RelayInstallLocations> {
		const custom = this.#env.installLocations;
		const registryFile = custom?.registryFile ?? getBrowserRelayInstallRegistryFile();
		const defaultDir =
			custom?.defaultDir ??
			(custom?.registryFile
				? path.join(path.dirname(custom.registryFile), "extension")
				: defaultRelayExtensionDir());
		const relayUrl =
			custom?.relayUrl !== undefined
				? custom.relayUrl
				: custom?.registryFile
					? null
					: (discoverRelayEndpoints()[0] ?? null);
		return { registryFile, defaultDir, relayUrl };
	}

	#hostDir(): string {
		if (this.#env.hostDir) return path.resolve(this.#env.hostDir);
		return path.dirname(this.#installLocations().registryFile);
	}

	#hostOptions(): RelayNativeHostOptions {
		return {
			platform: this.#platform(),
			home: this.#env.locations?.home,
			configHome: this.#env.locations?.configHome,
			dir: this.#hostDir(),
			command: this.#env.command,
		};
	}

	#manifestPaths(): Array<{ browser?: string; path: string }> {
		const platform = this.#platform();
		const dir = this.#hostDir();
		const file = `${NATIVE_HOST}.json`;
		if (platform === "win32") return [{ path: path.join(dir, file) }];
		return chromiumUserDataDirs(this.#env.locations).map(entry => ({
			browser: entry.browser,
			path: path.join(entry.dir, "NativeMessagingHosts", file),
		}));
	}

	#launcherPath(): string {
		return path.join(this.#hostDir(), this.#platform() === "win32" ? "native-host.cmd" : "native-host");
	}

	async #expectedBuild(): Promise<string | null> {
		if (embeddedRelayExtensionBuild) return embeddedRelayExtensionBuild;
		try {
			return (await loadRelayExtension()).build;
		} catch {
			return null;
		}
	}

	#hasCustomInstallScope(): boolean {
		return Boolean(
			this.#env.installLocations?.registryFile ||
			this.#env.installLocations?.defaultDir ||
			this.#env.hostDir ||
			this.#env.locations?.platform ||
			this.#env.locations?.home ||
			this.#env.locations?.configHome ||
			this.#env.command ||
			this.#env.runRegistry,
		);
	}

	async #registerNativeHost(
		extensionIds: readonly string[],
	): Promise<{ manifestPaths: string[]; registryUpdated: boolean }> {
		const platform = this.#platform();
		if (!this.#hasCustomInstallScope()) {
			const manifestPaths = await writeRelayNativeHost(extensionIds, this.#hostOptions());
			if (platform !== "win32" || manifestPaths.length === 0) {
				return { manifestPaths, registryUpdated: false };
			}
			await registerRelayNativeHost(extensionIds);
			return { manifestPaths, registryUpdated: true };
		}
		const manifestPaths = await writeRelayNativeHost(extensionIds, this.#hostOptions());
		if (platform !== "win32" || manifestPaths.length === 0) {
			return { manifestPaths, registryUpdated: false };
		}
		const runRegistry = this.#env.runRegistry ?? defaultRunRegistry;
		const key = WIN_NATIVE_HOST_KEYS[0]!.key;
		const result = await runRegistry(["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPaths[0]!, "/f"]);
		if (result.exitCode !== 0) {
			throw new Error(
				runtimeText(
					`无法注册 Native Host：${result.stderr.trim()}`,
					`Could not register the omp native messaging host: ${result.stderr.trim()}`,
				),
			);
		}
		return { manifestPaths, registryUpdated: true };
	}

	async #refreshNativeHost(extensionIds: readonly string[]): Promise<void> {
		await refreshRelayNativeHost(extensionIds, this.#hostOptions());
	}

	async #inspectPolicies(extensionIds: readonly string[]): Promise<ChromeRelayPolicyStatus> {
		const platform = this.#platform();
		const denials: ChromeRelayPolicyDenial[] = [];
		const warnings: string[] = [];

		if (platform === "win32") {
			const runRegistry = this.#env.runRegistry ?? defaultRunRegistry;
			for (const hive of ["HKLM", "HKCU"] as const) {
				const scope = hive === "HKLM" ? "machine" : "user";
				for (const target of WIN_POLICY_TARGETS) {
					const baseKey = `${hive}\\${target.subkey}`;
					const record: Record<string, unknown> = {};
					let hasAny = false;
					try {
						for (const listKey of [
							"ExtensionInstallBlocklist",
							"ExtensionInstallAllowlist",
							"NativeMessagingBlocklist",
							"NativeMessagingAllowlist",
						] as const) {
							const res = await runRegistry(["query", `${baseKey}\\${listKey}`]);
							if (res.exitCode === 0) {
								const items = parseRegList(res.stdout);
								if (items.length > 0) {
									record[listKey] = items;
									hasAny = true;
								}
							}
						}
						const userHosts = await runRegistry(["query", baseKey, "/v", "NativeMessagingUserLevelHosts"]);
						if (userHosts.exitCode === 0) {
							const dword = parseRegDword(userHosts.stdout, "NativeMessagingUserLevelHosts");
							if (dword !== undefined) {
								record.NativeMessagingUserLevelHosts = dword;
								hasAny = true;
							}
						}
					} catch (error) {
						warnings.push(
							runtimeText(
								`无法检查策略 ${baseKey}: ${String(error)}`,
								`Policy check failed for ${baseKey}: ${String(error)}`,
							),
						);
					}
					if (hasAny) {
						evaluatePolicyRecord(
							record,
							{ browser: target.browser, scope, source: baseKey, extensionIds },
							denials,
						);
					}
				}
			}
		} else if (platform === "darwin") {
			const runPlutil = this.#env.runPlutil ?? defaultRunPlutil;
			const user = os.userInfo().username;
			const dirs = this.#env.macManagedPolicyDirs ?? [
				path.join("/Library", "Managed Preferences"),
				...(user ? [path.join("/Library", "Managed Preferences", user)] : []),
			];
			for (const [index, dir] of dirs.entries()) {
				const scope: "machine" | "managed" = index === 0 ? "machine" : "managed";
				for (const target of MAC_POLICY_TARGETS) {
					for (const ext of [".plist", ".json"] as const) {
						const candidate = path.join(dir, `${target.bundleId}${ext}`);
						try {
							await fs.access(candidate);
						} catch {
							continue;
						}
						try {
							let parsed: unknown;
							if (ext === ".json") {
								parsed = await Bun.file(candidate).json();
							} else {
								const converted = await runPlutil(candidate);
								if (converted.exitCode !== 0) {
									warnings.push(
										runtimeText(
											`无法读取 macOS 管理策略 ${candidate}: ${converted.stderr.trim()}`,
											`Could not read macOS managed preference ${candidate}: ${converted.stderr.trim()}`,
										),
									);
									continue;
								}
								parsed = JSON.parse(converted.stdout);
							}
							if (isRecord(parsed)) {
								evaluatePolicyRecord(
									parsed,
									{ browser: target.browser, scope, source: candidate, extensionIds },
									denials,
								);
							}
						} catch (error) {
							warnings.push(
								runtimeText(
									`无法检查策略 ${candidate}: ${String(error)}`,
									`Policy check failed for ${candidate}: ${String(error)}`,
								),
							);
						}
					}
				}
			}
		} else if (platform === "linux") {
			const dirs = this.#env.linuxPolicyDirs ?? LINUX_POLICY_DIRS;
			for (const { browser, dir } of dirs) {
				let entries: string[];
				try {
					entries = await fs.readdir(dir);
				} catch {
					continue;
				}
				for (const file of entries.sort()) {
					if (!file.endsWith(".json")) continue;
					const fullPath = path.join(dir, file);
					try {
						const parsed: unknown = await Bun.file(fullPath).json();
						if (isRecord(parsed)) {
							evaluatePolicyRecord(
								parsed,
								{ browser, scope: "managed", source: fullPath, extensionIds },
								denials,
							);
						}
					} catch (error) {
						warnings.push(
							runtimeText(
								`无法检查策略 ${fullPath}: ${String(error)}`,
								`Policy check failed for ${fullPath}: ${String(error)}`,
							),
						);
					}
				}
			}
		}

		const extensionBlocked = denials.some(d => d.policy === "ExtensionInstallBlocklist");
		const nativeHostBlocked = denials.some(d => d.policy === "NativeMessagingBlocklist");
		const userLevelHostsDisabled = denials.some(d => d.policy === "NativeMessagingUserLevelHosts");
		return {
			checked: warnings.length === 0 && ["win32", "darwin", "linux"].includes(platform),
			platform,
			blocked: denials.length > 0,
			extensionBlocked,
			nativeHostBlocked,
			userLevelHostsDisabled,
			denials,
			warnings,
		};
	}

	async #inspectNativeHost(extensionIds: readonly string[]): Promise<ChromeRelayNativeHostStatus> {
		const platform = this.#platform();
		const launcherPath = this.#launcherPath();
		const launcherText = await Bun.file(launcherPath)
			.text()
			.catch(() => null);
		const launcherExists = launcherText !== null;
		const launcherValid =
			launcherText === relayNativeHostLauncherText(platform, this.#env.command ?? resolveCliEntryCmd());

		const expectedOrigins = new Set(extensionIds.map(id => `chrome-extension://${id}/`));
		const manifests: ChromeRelayNativeHostManifestRow[] = [];
		for (const target of this.#manifestPaths()) {
			let raw: string | null = null;
			try {
				raw = await Bun.file(target.path).text();
			} catch (error) {
				if (!isEnoent(error)) {
					manifests.push({
						...(target.browser ? { browser: target.browser } : {}),
						path: target.path,
						exists: true,
						valid: false,
						pathMatchesLauncher: false,
						allowedOrigins: [],
						missingExtensionIds: [...extensionIds],
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}
			}
			if (raw === null) {
				manifests.push({
					...(target.browser ? { browser: target.browser } : {}),
					path: target.path,
					exists: false,
					valid: false,
					pathMatchesLauncher: false,
					allowedOrigins: [],
					missingExtensionIds: [...extensionIds],
				});
				continue;
			}
			try {
				const parsed: unknown = JSON.parse(raw);
				const obj = isRecord(parsed) ? parsed : {};
				const allowedOrigins = Array.isArray(obj.allowed_origins)
					? obj.allowed_origins.filter((entry): entry is string => typeof entry === "string")
					: [];
				const manifestPath = typeof obj.path === "string" ? obj.path : "";
				const pathMatchesLauncher = manifestPath !== "" && samePath(manifestPath, launcherPath, platform);
				const originSet = new Set(allowedOrigins);
				const missingExtensionIds = extensionIds.filter(id => !originSet.has(`chrome-extension://${id}/`));
				const valid =
					obj.name === NATIVE_HOST &&
					obj.type === "stdio" &&
					pathMatchesLauncher &&
					missingExtensionIds.length === 0 &&
					(expectedOrigins.size === 0 || allowedOrigins.length > 0);
				manifests.push({
					...(target.browser ? { browser: target.browser } : {}),
					path: target.path,
					exists: true,
					valid,
					pathMatchesLauncher,
					allowedOrigins,
					missingExtensionIds,
				});
			} catch (error) {
				manifests.push({
					...(target.browser ? { browser: target.browser } : {}),
					path: target.path,
					exists: true,
					valid: false,
					pathMatchesLauncher: false,
					allowedOrigins: [],
					missingExtensionIds: [...extensionIds],
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const windowsRegistry: ChromeRelayWindowsRegistryEntry[] = [];
		if (platform === "win32") {
			const runRegistry = this.#env.runRegistry ?? defaultRunRegistry;
			const expectedManifest = manifests[0]?.path;
			for (const entry of WIN_NATIVE_HOST_KEYS) {
				try {
					const res = await runRegistry(["query", entry.key, "/ve"]);
					if (res.exitCode !== 0) {
						windowsRegistry.push({
							browser: entry.browser,
							key: entry.key,
							registered: false,
							matchesManifest: false,
						});
						continue;
					}
					const regPath = parseRegDefaultSz(res.stdout);
					const matchesManifest = Boolean(
						regPath && expectedManifest && samePath(regPath, expectedManifest, platform),
					);
					windowsRegistry.push({
						browser: entry.browser,
						key: entry.key,
						registered: true,
						...(regPath ? { manifestPath: regPath } : {}),
						matchesManifest,
					});
				} catch (error) {
					windowsRegistry.push({
						browser: entry.browser,
						key: entry.key,
						registered: false,
						matchesManifest: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		const hasValidManifest = manifests.some(m => m.exists && m.valid);
		const winRegistered =
			platform !== "win32" || windowsRegistry.some(entry => entry.registered && entry.matchesManifest);
		const registered = launcherExists && launcherValid && hasValidManifest && winRegistered;
		const needsRepair =
			!launcherExists ||
			!launcherValid ||
			!hasValidManifest ||
			manifests.some(m => m.exists && !m.valid) ||
			(platform === "win32" && !winRegistered);

		return {
			hostName: NATIVE_HOST,
			platform,
			launcherPath,
			launcherExists,
			launcherValid,
			registered,
			needsRepair,
			manifests,
			windowsRegistry,
		};
	}

	async #inspectProfiles(
		extensionIds: readonly string[],
		primaryExtensionId: string,
	): Promise<ChromeRelayProfileRow[]> {
		const targetIds = extensionIds.length > 0 ? extensionIds : [primaryExtensionId];
		const rows: ChromeRelayProfileRow[] = [];
		// Wrap upstream `findUnpackedInstalls` for canonical detection, then enrich with `profileDir` and `disabled`.
		const baseByKey = new Map<string, ChromiumProfileInstall>();
		for (const item of await findUnpackedInstalls(primaryExtensionId, this.#env.locations)) {
			baseByKey.set(`${item.browser}\0${item.profile}`, item);
		}
		for (const { browser, dir } of chromiumUserDataDirs(this.#env.locations)) {
			const localState = await readJsonSafe(path.join(dir, "Local State"));
			const profiles =
				isRecord(localState) && isRecord(localState.profile) ? localState.profile.info_cache : undefined;
			if (!isRecord(profiles)) continue;
			for (const [profileDir, info] of Object.entries(profiles)) {
				const prefs = await readJsonSafe(path.join(dir, profileDir, "Preferences"));
				const secure = await readJsonSafe(path.join(dir, profileDir, "Secure Preferences"));
				let matchedId = primaryExtensionId;
				let settings: Record<string, unknown> | undefined;
				for (const candidateId of targetIds) {
					const found =
						(isRecord(secure) &&
						isRecord(secure.extensions) &&
						isRecord(secure.extensions.settings) &&
						isRecord(secure.extensions.settings[candidateId])
							? secure.extensions.settings[candidateId]
							: undefined) ??
						(isRecord(prefs) &&
						isRecord(prefs.extensions) &&
						isRecord(prefs.extensions.settings) &&
						isRecord(prefs.extensions.settings[candidateId])
							? prefs.extensions.settings[candidateId]
							: undefined);
					if (found) {
						matchedId = candidateId;
						settings = found;
						break;
					}
				}
				const profileName = isRecord(info) && typeof info.name === "string" ? info.name : profileDir;
				const upstream = baseByKey.get(`${browser}\0${profileName}`);
				const loaded =
					settings?.location === UNPACKED_LOCATION ||
					Boolean(upstream?.loaded && matchedId === primaryExtensionId);
				const reasons = settings?.disable_reasons;
				const disabledFlag =
					settings !== undefined
						? settings.state === 0 ||
							(Array.isArray(reasons) ? reasons.length > 0 : typeof reasons === "number" && reasons !== 0)
						: Boolean(loaded && !upstream?.enabled);
				const enabled = loaded && !disabledFlag;
				const devMode =
					(isRecord(secure) &&
					isRecord(secure.extensions) &&
					isRecord(secure.extensions.ui) &&
					typeof secure.extensions.ui.developer_mode === "boolean"
						? secure.extensions.ui.developer_mode
						: undefined) ??
					(isRecord(prefs) &&
					isRecord(prefs.extensions) &&
					isRecord(prefs.extensions.ui) &&
					typeof prefs.extensions.ui.developer_mode === "boolean"
						? prefs.extensions.ui.developer_mode
						: undefined) ??
					upstream?.developerMode ??
					false;
				rows.push({
					browser,
					profile: profileName,
					profileDir,
					extensionId: matchedId,
					loaded,
					enabled,
					disabled: loaded ? disabledFlag : false,
					developerMode: devMode,
					...(Array.isArray(reasons)
						? { disableReasons: reasons.filter((r): r is number => typeof r === "number") }
						: typeof reasons === "number"
							? { disableReasons: reasons }
							: {}),
				});
			}
		}
		return rows;
	}

	async #probeHealth(probeHealth: boolean): Promise<ChromeRelayHealthStatus> {
		const settingEnabled = this.session.settings ? cfgBrowserRelay.get(this.session.settings) : false;
		const configuredUrl = this.session.settings
			? cfgBrowserRelayUrl.get(this.session.settings)?.trim() || undefined
			: undefined;
		const discoveredEndpoints = discoverRelayEndpoints();
		const candidates = new Map<string, boolean>();
		if (configuredUrl) candidates.set(configuredUrl.replace(/\/+$/, ""), true);
		for (const url of discoveredEndpoints) {
			const normalized = url.replace(/\/+$/, "");
			if (!candidates.has(normalized)) candidates.set(normalized, false);
		}
		if (!probeHealth) {
			return {
				settingEnabled,
				...(configuredUrl ? { configuredUrl } : {}),
				discoveredEndpoints,
				endpoints: [],
				ready: false,
			};
		}

		const probe = this.#env.probeRelay ?? probeCdpResponse;
		const timeoutMs = this.#env.probeTimeoutMs ?? 500;
		const endpoints: ChromeRelayEndpointHealth[] = [];
		for (const [url, configured] of candidates.entries()) {
			const response = await probe(`${url}/json/version`, { timeoutMs }).catch(() => null);
			if (response === null) {
				endpoints.push({ url, configured, outcome: "unreachable" });
				continue;
			}
			let parsed: Record<string, unknown> | undefined;
			try {
				const raw: unknown = JSON.parse(response.body);
				if (isRecord(raw)) parsed = raw;
			} catch {
				parsed = undefined;
			}
			const relayVersion = parsed ? relayVersionOf(parsed) : "";
			const relayInstance =
				parsed && typeof parsed.ompRelayInstance === "string" ? parsed.ompRelayInstance : undefined;
			const cdpClients = parsed ? relayCdpClientsOf(parsed) : null;
			const extensionVersion =
				parsed && typeof parsed.ompExtensionVersion === "string" ? parsed.ompExtensionVersion : undefined;

			let outcome: ChromeRelayEndpointHealth["outcome"];
			let notice: string | undefined;
			if (response.status >= 200 && response.status < 300) {
				if (!parsed || parsed.ompRelayDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)) {
					outcome = "outdated-relay";
				} else if (parsed.ompExtensionDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)) {
					outcome = relayVersion !== VERSION ? "outdated-relay" : "outdated-extension";
				} else if (isOlderOmpVersion(relayVersion, VERSION) && cdpClients === 0) {
					outcome = "idle-older-relay";
				} else {
					outcome = "ready";
					if (extensionVersion !== undefined && isOlderOmpVersion(extensionVersion, VERSION)) {
						const origin =
							extensionVersion === "" ? "an older omp" : `omp ${extensionVersion}; this is omp ${VERSION}`;
						notice = runtimeText(
							`扩展版本已过期（${origin}）。请同步更新，并在 Chrome 中重新加载。`,
							`The omp extension is out of date (installed by ${origin}). Sync/update and reload the extension in Chrome.`,
						);
					}
				}
			} else if (response.status === 503) {
				outcome = parsed && relayVersion !== VERSION ? "outdated-relay" : "no-extension";
			} else {
				outcome = "unreachable";
			}

			endpoints.push({
				url,
				configured,
				outcome,
				httpStatus: response.status,
				...(relayVersion ? { relayVersion } : {}),
				...(relayInstance ? { relayInstance } : {}),
				...(extensionVersion !== undefined ? { extensionVersion } : {}),
				...(cdpClients !== null ? { cdpClients } : {}),
				...(notice ? { notice } : {}),
			});
		}

		const ready = endpoints.some(ep => ep.outcome === "ready");
		const firstNotice = endpoints.find(ep => ep.notice)?.notice;
		return {
			settingEnabled,
			...(configuredUrl ? { configuredUrl } : {}),
			discoveredEndpoints,
			endpoints,
			ready,
			...(firstNotice ? { notice: firstNotice } : {}),
		};
	}

	async getStatus(options: { dir?: string; probeHealth?: boolean } = {}): Promise<ChromeRelayHostStatus> {
		const locations = this.#installLocations();
		const platform = this.#platform();
		const registry = await readRelayInstallRegistry(locations.registryFile).catch(() => ({
			installs: [],
			lastSynced: undefined,
		}));
		const recordedByKey = new Map<string, string | null>();
		for (const row of registry.installs) {
			const key = platform === "win32" ? row.dir.toLowerCase() : row.dir;
			recordedByKey.set(key, row.ompVersion);
		}
		const panelInstalls = await readRelayInstalls(locations).catch(() => []);
		const dirs = new Set<string>(panelInstalls.map(row => row.dir));
		if (options.dir) dirs.add(path.resolve(options.dir));
		if (dirs.size === 0) dirs.add(path.resolve(locations.defaultDir));

		const expectedBuild = await this.#expectedBuild();
		const installs: ChromeRelayExtensionInstallRow[] = [];
		for (const candidateDir of dirs) {
			const exists = await Bun.file(path.join(candidateDir, "manifest.json")).exists();
			const canonical = exists
				? await fs.realpath(candidateDir).catch(() => path.resolve(candidateDir))
				: path.resolve(candidateDir);
			const computedId = (await unpackedExtensionId(canonical)) ?? extensionIdForPath(canonical, platform);
			const installedVersion = exists ? await installedRelayExtensionVersion(canonical) : "";
			const stamp = exists ? await installedRelayExtensionStamp(canonical) : null;
			const key = platform === "win32" ? canonical.toLowerCase() : canonical;
			const recordedVersion = recordedByKey.get(key) ?? null;
			const upToDate =
				exists &&
				installedVersion === VERSION &&
				stamp !== null &&
				stamp.ompVersion === VERSION &&
				(expectedBuild === null || stamp.ompBuild === expectedBuild);
			installs.push({
				dir: canonical,
				extensionId: computedId,
				exists,
				missing: !exists,
				recordedVersion,
				installedVersion,
				installedBuild: stamp?.ompBuild ?? null,
				expectedVersion: VERSION,
				expectedBuild,
				upToDate,
				isDefault: samePath(canonical, locations.defaultDir, platform),
			});
		}

		const defaultExtensionId =
			(await unpackedExtensionId(locations.defaultDir)) ??
			extensionIdForPath(path.resolve(locations.defaultDir), platform);
		const registeredIds = await registeredRelayExtensionIds(locations).catch(() => []);
		const allIds = [...new Set([...registeredIds, ...installs.filter(i => i.exists).map(i => i.extensionId)])];
		const primaryId =
			(options.dir ? installs.find(i => samePath(i.dir, options.dir!, platform))?.extensionId : undefined) ??
			allIds[0] ??
			defaultExtensionId;

		const findInstalledBrowsers = this.#env.findInstalledBrowsers ?? installedChromiumBrowsers;
		const discoveredBrowsers = await findInstalledBrowsers(this.#env.locations).catch(() => []);
		const browsers: ChromeRelayBrowserRow[] = await Promise.all(
			discoveredBrowsers.map(async b => ({
				name: b.name,
				userDataDir: b.dir,
				executable: b.executable,
				...(b.bundleId ? { bundleId: b.bundleId } : {}),
				lastUsedProfile: await lastUsedProfile(b.dir),
			})),
		);

		const [profiles, nativeHost, health, policy] = await Promise.all([
			this.#inspectProfiles(allIds, primaryId),
			this.#inspectNativeHost(allIds),
			this.#probeHealth(options.probeHealth !== false),
			this.#inspectPolicies(allIds.length ? allIds : [defaultExtensionId]),
		]);

		return {
			ompVersion: VERSION,
			expectedBuild,
			defaultExtensionDir: path.resolve(locations.defaultDir),
			defaultExtensionId,
			registryFile: locations.registryFile,
			...(registry.lastSynced ? { lastSynced: registry.lastSynced } : {}),
			installs,
			browsers,
			profiles,
			nativeHost,
			health,
			policy,
		};
	}

	async #restartOutdatedRelays(): Promise<string[]> {
		const restart = this.#env.restartRelay ?? requestRelayRestart;
		const health = await this.#probeHealth(true);
		const restarted: string[] = [];
		for (const endpoint of health.endpoints) {
			if (
				endpoint.outcome === "idle-older-relay" ||
				(endpoint.relayVersion && isOlderOmpVersion(endpoint.relayVersion, VERSION))
			) {
				const ok = await restart(endpoint.url, { idleOnly: true }).catch(() => false);
				if (ok) restarted.push(endpoint.url);
			}
		}
		return restarted;
	}

	async install(
		options: {
			dir?: string;
			browser?: string;
			profile?: string;
			registerChrome?: boolean;
		} = {},
	): Promise<ChromeRelayHostInstallResult> {
		const locations = this.#installLocations();
		const targetDir = path.resolve(options.dir ?? locations.defaultDir);
		const canonicalDir = await installRelayExtension(targetDir, locations);
		const extensionIds = await registeredRelayExtensionIds(locations);
		const { manifestPaths } = await this.#registerNativeHost(extensionIds);
		const extensionId = extensionIdForPath(canonicalDir, this.#platform());
		const warnings: string[] = [];

		let profileInstalls: ChromeRelayProfileInstallReport[] = [];
		let profileInstallError: string | undefined;
		if (options.registerChrome !== false) {
			const existingProfiles = await findUnpackedInstalls(extensionId, this.#env.locations);
			const alreadyLoaded =
				!options.profile &&
				existingProfiles.some(
					row =>
						row.loaded && (!options.browser || row.browser.toLowerCase().includes(options.browser.toLowerCase())),
				);
			if (!alreadyLoaded) {
				const installChrome = this.#env.installInChrome ?? installRelayInChrome;
				try {
					profileInstalls = await installChrome({
						dir: canonicalDir,
						browser: options.browser,
						profile: options.profile,
					});
				} catch (error) {
					profileInstallError = error instanceof Error ? error.message : String(error);
					warnings.push(
						runtimeText(
							`无法向 Chrome Profile 注册扩展：${profileInstallError}`,
							`Could not register extension in Chrome profile: ${profileInstallError}`,
						),
					);
				}
			}
		}

		const status = await this.getStatus({ dir: canonicalDir });
		for (const denial of status.policy.denials) warnings.push(denial.reason);
		return {
			action: "install",
			dir: canonicalDir,
			extensionId,
			ompVersion: VERSION,
			manifestPaths,
			registeredNativeHost: true,
			profileInstalls,
			...(profileInstallError ? { profileInstallError } : {}),
			warnings,
			status,
		};
	}

	async sync(options: { restartOutdatedRelay?: boolean } = {}): Promise<ChromeRelayHostSyncResult> {
		const locations = this.#installLocations();
		const rawResults: RelayInstallSyncResult[] = await syncRelayInstalls({
			mode: "explicit",
			...locations,
		});
		const extensionIds = await registeredRelayExtensionIds(locations).catch(() => []);
		if (extensionIds.length > 0) await this.#refreshNativeHost(extensionIds).catch(() => {});

		const restartedEndpoints = options.restartOutdatedRelay ? await this.#restartOutdatedRelays() : [];
		const status = await this.getStatus();
		const warnings = [
			...rawResults.filter(r => r.status === "failed").map(r => `${r.dir}: ${r.error}`),
			...status.policy.denials.map(d => d.reason),
		];
		return {
			action: "sync",
			results: rawResults as ChromeRelayHostSyncItem[],
			restartedEndpoints,
			warnings,
			status,
		};
	}

	async update(options: { dir?: string; restartOutdatedRelay?: boolean } = {}): Promise<ChromeRelayHostUpdateResult> {
		const locations = this.#installLocations();
		const registry = await readRelayInstallRegistry(locations.registryFile).catch(() => ({ installs: [] }));
		if (
			registry.installs.length === 0 &&
			(options.dir || (await Bun.file(path.join(locations.defaultDir, "manifest.json")).exists()))
		) {
			const installedDir = await installRelayExtension(path.resolve(options.dir ?? locations.defaultDir), locations);
			const ids = await registeredRelayExtensionIds(locations);
			await this.#registerNativeHost(ids);
			const restartedEndpoints = options.restartOutdatedRelay !== false ? await this.#restartOutdatedRelays() : [];
			const status = await this.getStatus({ dir: installedDir });
			return {
				action: "update",
				results: [{ dir: installedDir, status: "written", ompVersion: VERSION }],
				restartedEndpoints,
				warnings: status.policy.denials.map(d => d.reason),
				status,
			};
		}
		const rawResults = await syncRelayInstalls({ mode: "explicit", ...locations });
		const ids = await registeredRelayExtensionIds(locations).catch(() => []);
		if (ids.length > 0) {
			const hostStatus = await this.#inspectNativeHost(ids);
			if (hostStatus.needsRepair) await this.#registerNativeHost(ids);
			else await this.#refreshNativeHost(ids);
		}
		const restartedEndpoints = options.restartOutdatedRelay !== false ? await this.#restartOutdatedRelays() : [];
		const status = await this.getStatus({ dir: options.dir });
		const warnings = [
			...rawResults.filter(r => r.status === "failed").map(r => `${r.dir}: ${r.error}`),
			...status.policy.denials.map(d => d.reason),
		];
		return {
			action: "update",
			results: rawResults as ChromeRelayHostSyncItem[],
			restartedEndpoints,
			warnings,
			status,
		};
	}

	async repair(
		options: {
			browser?: string;
			profile?: string;
			repairProfile?: boolean;
			installIfMissing?: boolean;
		} = {},
	): Promise<ChromeRelayHostRepairResult> {
		const locations = this.#installLocations();
		let extensionIds = await registeredRelayExtensionIds(locations).catch(() => []);
		if (extensionIds.length === 0 && options.installIfMissing !== false) {
			await installRelayExtension(locations.defaultDir, locations);
			extensionIds = await registeredRelayExtensionIds(locations);
		}
		const syncResults =
			extensionIds.length > 0
				? ((await syncRelayInstalls({ mode: "explicit", ...locations })) as ChromeRelayHostSyncItem[])
				: [];
		const idsToRegister =
			extensionIds.length > 0
				? extensionIds
				: [extensionIdForPath(path.resolve(locations.defaultDir), this.#platform())];
		const { manifestPaths, registryUpdated } = await this.#registerNativeHost(idsToRegister);

		const warnings: string[] = [];
		let profileInstalls: ChromeRelayProfileInstallReport[] = [];
		let profileInstallError: string | undefined;
		if (options.repairProfile) {
			const registry = await readRelayInstallRegistry(locations.registryFile).catch(() => ({ installs: [] }));
			const targetDir = registry.installs[0]?.dir ?? locations.defaultDir;
			if (await Bun.file(path.join(targetDir, "manifest.json")).exists()) {
				const installChrome = this.#env.installInChrome ?? installRelayInChrome;
				try {
					profileInstalls = await installChrome({
						dir: targetDir,
						browser: options.browser,
						profile: options.profile,
					});
				} catch (error) {
					profileInstallError = error instanceof Error ? error.message : String(error);
					warnings.push(
						runtimeText(
							`无法修复 Chrome Profile 扩展注册：${profileInstallError}`,
							`Could not repair Chrome profile registration: ${profileInstallError}`,
						),
					);
				}
			}
		}

		const status = await this.getStatus();
		for (const denial of status.policy.denials) warnings.push(denial.reason);
		return {
			action: "repair",
			extensionIds: idsToRegister,
			manifestPaths,
			registryUpdated,
			syncResults,
			profileInstalls,
			...(profileInstallError ? { profileInstallError } : {}),
			warnings,
			status,
		};
	}

	async uninstall(
		options: {
			removeProfileRegistrations?: boolean;
			removeExtensionFiles?: boolean;
		} = {},
	): Promise<ChromeRelayHostUninstallResult> {
		const platform = this.#platform();
		const locations = this.#installLocations();
		const warnings: string[] = [];

		const registry = await readRelayInstallRegistry(locations.registryFile).catch(() => ({ installs: [] }));
		const registeredIds = await registeredRelayExtensionIds(locations).catch(() => []);
		const defaultId =
			(await unpackedExtensionId(locations.defaultDir)) ??
			extensionIdForPath(path.resolve(locations.defaultDir), platform);
		const candidateIds = new Set<string>([...registeredIds, defaultId]);

		const removedManifestPaths: string[] = [];
		for (const target of this.#manifestPaths()) {
			try {
				await fs.unlink(target.path);
				removedManifestPaths.push(target.path);
			} catch (error) {
				if (!isEnoent(error)) {
					warnings.push(
						runtimeText(
							`无法移除清单 ${target.path}: ${String(error)}`,
							`Failed to remove manifest ${target.path}: ${String(error)}`,
						),
					);
				}
			}
		}

		let removedLauncherPath: string | undefined;
		const launcher = this.#launcherPath();
		try {
			await fs.unlink(launcher);
			removedLauncherPath = launcher;
		} catch (error) {
			if (!isEnoent(error)) {
				warnings.push(
					runtimeText(
						`无法移除启动文件 ${launcher}: ${String(error)}`,
						`Failed to remove launcher ${launcher}: ${String(error)}`,
					),
				);
			}
		}

		const removedRegistryKeys: string[] = [];
		if (platform === "win32") {
			const runRegistry = this.#env.runRegistry ?? defaultRunRegistry;
			const expectedManifest = this.#manifestPaths()[0]?.path;
			for (const entry of WIN_NATIVE_HOST_KEYS) {
				try {
					const query = await runRegistry(["query", entry.key, "/ve"]);
					if (query.exitCode !== 0) continue;
					const registeredPath = parseRegDefaultSz(query.stdout);
					const isOurs =
						registeredPath !== undefined &&
						expectedManifest !== undefined &&
						samePath(registeredPath, expectedManifest, platform);
					if (!isOurs) continue;
					const del = await runRegistry(["delete", entry.key, "/f"]);
					if (del.exitCode === 0) removedRegistryKeys.push(entry.key);
					else
						warnings.push(
							runtimeText(
								`无法移除注册表项 ${entry.key}: ${del.stderr.trim()}`,
								`Failed to remove registry key ${entry.key}: ${del.stderr.trim()}`,
							),
						);
				} catch (error) {
					warnings.push(
						runtimeText(
							`无法移除注册表项 ${entry.key}: ${String(error)}`,
							`Failed to inspect/remove registry key ${entry.key}: ${String(error)}`,
						),
					);
				}
			}
		}

		const removedProfileRegistrations: Array<{ browser: string; profileDir: string; extensionId: string }> = [];
		if (options.removeProfileRegistrations !== false) {
			const findInstalledBrowsers = this.#env.findInstalledBrowsers ?? installedChromiumBrowsers;
			const installedBrowsers = await findInstalledBrowsers(this.#env.locations).catch(() => []);
			const browserStop = this.#env.stopBrowser ?? stopBrowser;
			const browserStart = this.#env.startBrowser ?? startBrowser;
			const browserByDir = new Map(
				installedBrowsers.map(b => [platform === "win32" ? b.dir.toLowerCase() : b.dir, b]),
			);

			for (const { browser, dir } of chromiumUserDataDirs(this.#env.locations)) {
				const localState = await readJsonSafe(path.join(dir, "Local State"));
				const profiles =
					isRecord(localState) && isRecord(localState.profile) ? localState.profile.info_cache : undefined;
				if (!isRecord(profiles)) continue;

				const matchingProfiles: string[] = [];
				for (const profileDir of Object.keys(profiles)) {
					const prefs = await readJsonSafe(path.join(dir, profileDir, "Preferences"));
					const secure = await readJsonSafe(path.join(dir, profileDir, "Secure Preferences"));
					const hasAny = [...candidateIds].some(id => {
						const secEntry =
							isRecord(secure) && isRecord(secure.extensions) && isRecord(secure.extensions.settings)
								? secure.extensions.settings[id]
								: undefined;
						const normEntry =
							isRecord(prefs) && isRecord(prefs.extensions) && isRecord(prefs.extensions.settings)
								? prefs.extensions.settings[id]
								: undefined;
						const chosen = isRecord(secEntry) ? secEntry : isRecord(normEntry) ? normEntry : undefined;
						return chosen !== undefined && chosen.location === UNPACKED_LOCATION;
					});
					if (hasAny) matchingProfiles.push(profileDir);
				}
				if (matchingProfiles.length === 0) continue;

				const browserInfo = browserByDir.get(platform === "win32" ? dir.toLowerCase() : dir);
				if (!browserInfo) {
					warnings.push(
						runtimeText(
							`无法定位 ${browser} 可执行文件，保留其 Profile 扩展记录。`,
							`Cannot locate ${browser}; its profile extension records were preserved.`,
						),
					);
					continue;
				}
				let wasRunning = false;
				try {
					wasRunning = await browserStop(browserInfo);
					for (const profileDir of matchingProfiles) {
						const removed = await unregisterUnpackedExtensions(
							browserInfo,
							path.join(dir, profileDir),
							candidateIds,
						);
						for (const id of removed) {
							removedProfileRegistrations.push({ browser, profileDir, extensionId: id });
						}
					}
				} catch (error) {
					warnings.push(
						runtimeText(
							`无法移除 ${browser} Profile 扩展注册：${String(error)}`,
							`Could not remove Chrome profile registration for ${browser}: ${String(error)}`,
						),
					);
				} finally {
					if (wasRunning && browserInfo) {
						await browserStart(browserInfo).catch(() => {});
					}
				}
			}
		}

		// Clear install registry entries (or delete installs.json).
		try {
			await fs.unlink(locations.registryFile);
		} catch (error) {
			if (!isEnoent(error)) {
				warnings.push(
					runtimeText(
						`无法移除安装记录 ${locations.registryFile}: ${String(error)}`,
						`Failed to remove install registry ${locations.registryFile}: ${String(error)}`,
					),
				);
			}
		}

		const removedExtensionDirs: string[] = [];
		if (options.removeExtensionFiles) {
			const bundle = await loadRelayExtension();
			for (const extDir of new Set([...registry.installs.map(row => row.dir), locations.defaultDir])) {
				const resolved = path.resolve(extDir);
				if (!(await installedRelayExtensionStamp(resolved))) continue;
				try {
					for (const name of Object.keys(bundle.files))
						await fs.unlink(path.join(resolved, name)).catch(error => {
							if (!isEnoent(error)) throw error;
						});
					await fs.rmdir(resolved).catch(error => {
						if (error.code !== "ENOTEMPTY") throw error;
					});
					removedExtensionDirs.push(resolved);
				} catch (error) {
					warnings.push(
						runtimeText(
							`无法移除扩展文件 ${resolved}: ${String(error)}`,
							`Could not remove extension files ${resolved}: ${String(error)}`,
						),
					);
				}
			}
		}

		const status = await this.getStatus({ probeHealth: false });
		return {
			action: "uninstall",
			removedManifestPaths,
			...(removedLauncherPath ? { removedLauncherPath } : {}),
			removedRegistryKeys,
			removedProfileRegistrations,
			removedExtensionDirs,
			warnings,
			status,
		};
	}

	async execute(operation: ChromeRelayHostOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId) {
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				runtimeText(
					"会话已变更，请刷新 Chrome 扩展状态",
					"The active session changed; reload Chrome relay host state",
				),
			);
		}
		switch (operation.kind) {
			case "browser.relayHost.status":
				return this.getStatus({ dir: operation.dir, probeHealth: operation.probeHealth });
			case "browser.relayHost.install":
				return this.install({
					dir: operation.dir,
					browser: operation.browser,
					profile: operation.profile,
					registerChrome: operation.registerChrome,
				});
			case "browser.relayHost.sync":
				return this.sync({ restartOutdatedRelay: operation.restartOutdatedRelay });
			case "browser.relayHost.update":
				return this.update({ dir: operation.dir, restartOutdatedRelay: operation.restartOutdatedRelay });
			case "browser.relayHost.repair":
				return this.repair({
					browser: operation.browser,
					profile: operation.profile,
					repairProfile: operation.repairProfile,
					installIfMissing: operation.installIfMissing,
				});
			case "browser.relayHost.uninstall":
				return this.uninstall({
					removeProfileRegistrations: operation.removeProfileRegistrations,
					removeExtensionFiles: operation.removeExtensionFiles,
				});
		}
	}
}
