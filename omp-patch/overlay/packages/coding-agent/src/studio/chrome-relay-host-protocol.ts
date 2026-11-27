import * as path from "node:path";
import { runtimeText } from "./locale";

export interface ChromeRelayExtensionInstallRow {
	dir: string;
	extensionId: string;
	exists: boolean;
	missing: boolean;
	recordedVersion: string | null;
	installedVersion: string;
	installedBuild: string | null;
	expectedVersion: string;
	expectedBuild: string | null;
	upToDate: boolean;
	isDefault: boolean;
}

export interface ChromeRelayBrowserRow {
	name: string;
	userDataDir: string;
	executable: string;
	bundleId?: string;
	lastUsedProfile: string;
}

export interface ChromeRelayProfileRow {
	browser: string;
	profile: string;
	profileDir: string;
	extensionId: string;
	loaded: boolean;
	enabled: boolean;
	disabled: boolean;
	developerMode: boolean;
	disableReasons?: number[] | number;
}

export interface ChromeRelayNativeHostManifestRow {
	browser?: string;
	path: string;
	exists: boolean;
	valid: boolean;
	pathMatchesLauncher: boolean;
	allowedOrigins: string[];
	missingExtensionIds: string[];
	error?: string;
}

export interface ChromeRelayWindowsRegistryEntry {
	browser: string;
	key: string;
	registered: boolean;
	manifestPath?: string;
	matchesManifest: boolean;
	error?: string;
}

export interface ChromeRelayNativeHostStatus {
	hostName: "sh.omp.browser";
	platform: string;
	launcherPath: string;
	launcherExists: boolean;
	launcherValid: boolean;
	registered: boolean;
	needsRepair: boolean;
	manifests: ChromeRelayNativeHostManifestRow[];
	windowsRegistry: ChromeRelayWindowsRegistryEntry[];
}

export type ChromeRelayEndpointOutcome =
	| "ready"
	| "unreachable"
	| "no-extension"
	| "outdated-relay"
	| "idle-older-relay"
	| "outdated-extension";

export interface ChromeRelayEndpointHealth {
	url: string;
	configured: boolean;
	outcome: ChromeRelayEndpointOutcome;
	httpStatus?: number;
	relayVersion?: string;
	relayInstance?: string;
	extensionVersion?: string;
	cdpClients?: number | null;
	notice?: string;
}

export interface ChromeRelayHealthStatus {
	settingEnabled: boolean;
	configuredUrl?: string;
	discoveredEndpoints: string[];
	endpoints: ChromeRelayEndpointHealth[];
	ready: boolean;
	notice?: string;
}

export type ChromeRelayPolicyKey =
	| "ExtensionInstallBlocklist"
	| "NativeMessagingBlocklist"
	| "NativeMessagingUserLevelHosts";

export interface ChromeRelayPolicyDenial {
	browser: string;
	policy: ChromeRelayPolicyKey;
	scope: "machine" | "user" | "managed";
	source: string;
	value: string | string[] | boolean | number;
	reason: string;
}

export interface ChromeRelayPolicyStatus {
	checked: boolean;
	platform: string;
	blocked: boolean;
	extensionBlocked: boolean;
	nativeHostBlocked: boolean;
	userLevelHostsDisabled: boolean;
	denials: ChromeRelayPolicyDenial[];
	warnings: string[];
}

export interface ChromeRelayHostStatus {
	ompVersion: string;
	expectedBuild: string | null;
	defaultExtensionDir: string;
	defaultExtensionId: string;
	registryFile: string;
	lastSynced?: string;
	installs: ChromeRelayExtensionInstallRow[];
	browsers: ChromeRelayBrowserRow[];
	profiles: ChromeRelayProfileRow[];
	nativeHost: ChromeRelayNativeHostStatus;
	health: ChromeRelayHealthStatus;
	policy: ChromeRelayPolicyStatus;
}

export type ChromeRelayHostSyncItem =
	| { dir: string; status: "written" | "up to date"; ompVersion: string }
	| { dir: string; status: "missing" }
	| { dir: string; status: "failed"; error: string };

export interface ChromeRelayProfileInstallReport {
	browser: string;
	profileDir: string;
	authenticators: "hmac+encrypted" | "hmac" | "unauthenticated";
	restarted: boolean;
}

export interface ChromeRelayHostInstallResult {
	action: "install";
	dir: string;
	extensionId: string;
	ompVersion: string;
	manifestPaths: string[];
	registeredNativeHost: boolean;
	profileInstalls: ChromeRelayProfileInstallReport[];
	profileInstallError?: string;
	warnings: string[];
	status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostSyncResult {
	action: "sync";
	results: ChromeRelayHostSyncItem[];
	restartedEndpoints: string[];
	warnings: string[];
	status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostUpdateResult {
	action: "update";
	results: ChromeRelayHostSyncItem[];
	restartedEndpoints: string[];
	warnings: string[];
	status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostRepairResult {
	action: "repair";
	extensionIds: string[];
	manifestPaths: string[];
	registryUpdated: boolean;
	syncResults: ChromeRelayHostSyncItem[];
	profileInstalls: ChromeRelayProfileInstallReport[];
	profileInstallError?: string;
	warnings: string[];
	status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostUninstallResult {
	action: "uninstall";
	removedManifestPaths: string[];
	removedLauncherPath?: string;
	removedRegistryKeys: string[];
	removedProfileRegistrations: Array<{ browser: string; profileDir: string; extensionId: string }>;
	removedExtensionDirs: string[];
	warnings: string[];
	status: ChromeRelayHostStatus;
}

export type ChromeRelayHostOperation =
	| { kind: "browser.relayHost.status"; sessionId: string; dir?: string; probeHealth?: boolean }
	| {
			kind: "browser.relayHost.install";
			sessionId: string;
			dir?: string;
			browser?: string;
			profile?: string;
			registerChrome?: boolean;
	  }
	| { kind: "browser.relayHost.sync"; sessionId: string; restartOutdatedRelay?: boolean }
	| { kind: "browser.relayHost.update"; sessionId: string; dir?: string; restartOutdatedRelay?: boolean }
	| {
			kind: "browser.relayHost.repair";
			sessionId: string;
			browser?: string;
			profile?: string;
			repairProfile?: boolean;
			installIfMissing?: boolean;
	  }
	| {
			kind: "browser.relayHost.uninstall";
			sessionId: string;
			removeProfileRegistrations?: boolean;
			removeExtensionFiles?: boolean;
	  };

export interface ChromeRelayHostResultMap {
	"browser.relayHost.status": ChromeRelayHostStatus;
	"browser.relayHost.install": ChromeRelayHostInstallResult;
	"browser.relayHost.sync": ChromeRelayHostSyncResult;
	"browser.relayHost.update": ChromeRelayHostUpdateResult;
	"browser.relayHost.repair": ChromeRelayHostRepairResult;
	"browser.relayHost.uninstall": ChromeRelayHostUninstallResult;
}

export const CHROME_RELAY_HOST_KINDS = [
	"browser.relayHost.status",
	"browser.relayHost.install",
	"browser.relayHost.sync",
	"browser.relayHost.update",
	"browser.relayHost.repair",
	"browser.relayHost.uninstall",
] as const;

export const CHROME_RELAY_HOST_READ_KINDS = ["browser.relayHost.status"] as const;

export function isChromeRelayHostKind(kind: string): kind is ChromeRelayHostOperation["kind"] {
	return (CHROME_RELAY_HOST_KINDS as readonly string[]).includes(kind);
}

function assertObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(runtimeText("Chrome 扩展操作必须是对象", "Expected a Chrome relay host operation object"));
	return value as Record<string, unknown>;
}

function assertText(value: unknown, field: string, max = 512): asserts value is string {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/u.test(value) || value.length > max)
		throw new Error(runtimeText(`${field} 无效`, `Invalid ${field}`));
}

function assertOptionalFlag(value: unknown, field: string): void {
	if (value !== undefined && typeof value !== "boolean")
		throw new Error(runtimeText(`${field} 无效`, `Invalid ${field}`));
}

function assertOptionalAbsoluteDir(value: unknown): void {
	if (value === undefined) return;
	assertText(value, "dir", 4096);
	if (!path.isAbsolute(value))
		throw new Error(runtimeText("扩展目录必须是绝对路径", "Extension directory must be an absolute path"));
}

function assertOptionalProfile(value: unknown): void {
	if (value === undefined) return;
	assertText(value, "profile", 128);
	if (value === "." || value === ".." || /[\\/:]/u.test(value))
		throw new Error(runtimeText("Profile 必须是浏览器配置目录名称", "Profile must name a browser profile directory"));
}

export function validateChromeRelayHostOperation(value: unknown): asserts value is ChromeRelayHostOperation {
	const input = assertObject(value);
	if (typeof input.kind !== "string" || !isChromeRelayHostKind(input.kind))
		throw new Error(runtimeText("未知的 Chrome 扩展操作", "Unknown Chrome relay host operation"));
	assertText(input.sessionId, "sessionId");

	switch (input.kind) {
		case "browser.relayHost.status":
			assertOptionalAbsoluteDir(input.dir);
			assertOptionalFlag(input.probeHealth, "probeHealth");
			return;
		case "browser.relayHost.install":
			assertOptionalAbsoluteDir(input.dir);
			if (input.browser !== undefined) assertText(input.browser, "browser", 128);
			assertOptionalProfile(input.profile);
			assertOptionalFlag(input.registerChrome, "registerChrome");
			return;
		case "browser.relayHost.sync":
			assertOptionalFlag(input.restartOutdatedRelay, "restartOutdatedRelay");
			return;
		case "browser.relayHost.update":
			assertOptionalAbsoluteDir(input.dir);
			assertOptionalFlag(input.restartOutdatedRelay, "restartOutdatedRelay");
			return;
		case "browser.relayHost.repair":
			if (input.browser !== undefined) assertText(input.browser, "browser", 128);
			assertOptionalProfile(input.profile);
			assertOptionalFlag(input.repairProfile, "repairProfile");
			assertOptionalFlag(input.installIfMissing, "installIfMissing");
			return;
		case "browser.relayHost.uninstall":
			assertOptionalFlag(input.removeProfileRegistrations, "removeProfileRegistrations");
			assertOptionalFlag(input.removeExtensionFiles, "removeExtensionFiles");
			return;
	}
}
