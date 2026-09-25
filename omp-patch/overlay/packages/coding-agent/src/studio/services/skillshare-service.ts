import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
	SkillPackument,
	SkillSearchHit,
	SkillToken,
	SkillVersionManifest,
	SkillVersionSummary,
} from "@oh-my-pi/pi-wire/skillshare";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	parseSkillSpec,
	SkillshareClient,
	SkillshareError,
	type SkillshareClientOptions,
} from "../../skillshare/client";
import {
	installSkillPackages,
	listInstalledSkills,
	resolveSkillVersion,
	uninstallSkillPackages,
	updateSkillPackages,
} from "../../skillshare/installer";
import {
	getSkillsInstallPaths,
	parseSkillId,
	readSkillsLock,
	readSkillsManifest,
	type SkillsInstallPaths,
} from "../../skillshare/manifest";
import { bumpVersion, packSkill, type PackResult } from "../../skillshare/pack";
import type { AgentSession } from "../../session/agent-session";
import {
	type SkillshareAction,
	type SkillshareActionState,
	type SkillshareHit,
	type SkillshareOperation,
	type SkillshareReview,
	type SkillshareVersion,
	validateSkillshareOperation,
	validateSkillshareResult,
} from "../skillshare-protocol";
import { SessionControlError } from "./session-control-service";

type NativeClient = SkillshareClient;
interface Plan {
	review: SkillshareReview;
	state: SkillshareActionState;
	sessionId: string;
	cwd: string;
	manifestFingerprint?: string;
	paths?: SkillsInstallPaths;
	pack?: PackResult;
	path?: string;
	zip?: Uint8Array;
	packuments: Map<string, SkillPackument>;
	manifests: Map<string, SkillVersionManifest>;
	promise?: Promise<void>;
}
export interface StudioSkillshareDependencies {
	directory?: string;
	client?: (options: SkillshareClientOptions) => Promise<NativeClient>;
	install?: typeof installSkillPackages;
	update?: typeof updateSkillPackages;
	uninstall?: typeof uninstallSkillPackages;
	installed?: typeof listInstalledSkills;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const clean = (value: string, max = 512) =>
	sanitizeText(value)
		.replace(/[\u0000-\u001f]/gu, " ")
		.slice(0, max);
const remoteAction = (type: SkillshareAction["type"]) =>
	!["install", "update", "uninstall", "version", "reload"].includes(type);
function version(value: SkillVersionSummary): SkillshareVersion {
	return {
		version: clean(value.version, 128),
		integrity: clean(value.integrity, 256),
		bytes: value.size,
		fileCount: value.fileCount,
		hasScripts: value.hasScripts,
		yanked: value.yanked,
		publishedAt: value.publishedAt,
		...(value.deprecated !== undefined ? { deprecated: clean(value.deprecated, 500) } : {}),
	};
}
function hit(value: SkillSearchHit): SkillshareHit {
	return {
		package: `@${value.scope}/${value.name}`,
		description: clean(value.description, 1024),
		version: value.version,
		downloads: value.weeklyDownloads,
		updatedAt: value.updatedAt,
		...(value.deprecated !== undefined ? { deprecated: clean(value.deprecated, 500) } : {}),
	};
}
function token(value: SkillToken): SkillToken {
	return {
		id: value.id,
		name: clean(value.name, 128),
		packages: value.packages,
		createdAt: value.createdAt,
		...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
		...(value.lastUsedAt !== undefined ? { lastUsedAt: value.lastUsedAt } : {}),
	};
}
function packageId(value: string) {
	const parsed = parseSkillId(value);
	if (!parsed) throw new SessionControlError("INVALID_ARGUMENT", "Use @scope/name");
	return parsed;
}

/** Native registry APIs, reviewed single-use mutations, and no implicit publish retries. */
export class StudioSkillshareService {
	readonly #plans = new Map<string, Plan>();
	readonly #controllers = new Set<AbortController>();
	readonly #directory: string | undefined;
	readonly #unsubscribe: () => void;
	readonly #secretFiles = new Set<string>();
	#disposed = false;
	#mutating = false;
	constructor(
		readonly session: AgentSession,
		readonly dependencies: StudioSkillshareDependencies = {},
	) {
		this.#directory = dependencies.directory ?? process.env.OMP_STUDIO_MEDIA_ROOT;
		this.#unsubscribe =
			session.registerSessionChangeCallback?.(() => {
				for (const controller of this.#controllers) controller.abort();
				for (const [id, plan] of this.#plans)
					if (plan.sessionId !== session.sessionId && plan.state.state !== "running") this.#plans.delete(id);
			}) ?? (() => {});
	}
	get running(): boolean {
		return this.#mutating;
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		for (const controller of this.#controllers) controller.abort();
		for (const file of this.#secretFiles) void unlink(file).catch(() => {});
		this.#secretFiles.clear();
	}
	#assert(sessionId: string, cwd?: string): void {
		if (
			this.#disposed ||
			this.session.sessionId !== sessionId ||
			(cwd && this.session.sessionManager.getCwd() !== cwd)
		)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Skillshare actions require the session and workspace that were reviewed",
			);
	}
	async #withClient<T>(forPublish: boolean, run: (client: NativeClient) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		this.#controllers.add(controller);
		const timer = setTimeout(() => controller.abort(), 60000);
		let client: NativeClient | undefined;
		try {
			client = await (this.dependencies.client ?? SkillshareClient.create)({
				registryUrl: this.session.settings.get("skills.registryUrl") || undefined,
				forPublish,
				signal: controller.signal,
			});
			return await run(client);
		} finally {
			clearTimeout(timer);
			this.#controllers.delete(controller);
			client?.close();
		}
	}
	async execute(operation: SkillshareOperation): Promise<unknown> {
		validateSkillshareOperation(operation);
		const cwd = this.session.sessionManager.getCwd();
		this.#assert(operation.sessionId, cwd);
		try {
			const result = await this.#execute(operation, cwd);
			this.#assert(operation.sessionId, cwd);
			validateSkillshareResult(operation.kind, result);
			return structuredClone(result);
		} catch (cause) {
			if (cause instanceof SessionControlError) throw cause;
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				cause instanceof SkillshareError
					? `Skillshare request failed (HTTP ${cause.status}). Check login, ownership and the selected version.`
					: "Skillshare could not complete this request. Check the registry, package metadata, workspace paths and local manifests.",
			);
		}
	}
	async #execute(operation: SkillshareOperation, cwd: string): Promise<unknown> {
		const own = () => [...this.#plans.values()].filter(plan => plan.sessionId === operation.sessionId);
		if (operation.kind === "skillshare.status")
			return this.#withClient(false, async account => ({
				registry: account.registryUrl,
				accountAuthenticated: !!(await account.authToken()),
				publishAuthenticated: await this.#withClient(true, async publish => !!(await publish.authToken())),
				privateTokenChannel: !!this.#directory,
				actions: own().map(plan => plan.state),
			}));
		if (operation.kind === "skillshare.home")
			return this.#withClient(false, async client => {
				const home = await client.home();
				return {
					stats: home.stats,
					recent: home.recent.slice(0, 50).map(hit),
					popular: home.popular.slice(0, 50).map(hit),
					trending: home.trending.slice(0, 50).map(hit),
				};
			});
		if (operation.kind === "skillshare.search")
			return this.#withClient(false, async client => {
				const result = await client.search(operation.query, { sort: operation.sort, page: operation.page });
				return {
					hits: result.hits.slice(0, 100).map(hit),
					total: result.total,
					page: result.page,
					perPage: result.perPage,
				};
			});
		if (operation.kind === "skillshare.tokens")
			return this.#withClient(false, async client => {
				const tokens = await client.listTokens();
				if (tokens.length > 200)
					throw new SessionControlError(
						"COMMAND_BLOCKED",
						"The token list exceeds Studio's 200-token limit; use the registry to manage it",
					);
				return { tokens: tokens.map(token) };
			});
		if (operation.kind === "skillshare.installed") {
			const all = await (this.dependencies.installed ?? listInstalledSkills)(cwd);
			const offset = operation.offset ?? 0;
			return {
				total: all.length,
				skills: all.slice(offset, offset + 100).map(row => ({
					package: row.id,
					scope: row.scope,
					stored: row.stored,
					...(row.version ? { version: row.version } : {}),
					...(row.range ? { range: row.range } : {}),
				})),
				...(offset + 100 < all.length ? { nextOffset: offset + 100 } : {}),
			};
		}
		if (operation.kind === "skillshare.package")
			return this.#withClient(false, async client => {
				const key = packageId(operation.package);
				const value = await client.packument(key.scope, key.name);
				const all = Object.values(value.versions).sort((a, b) => Bun.semver.order(b.version, a.version));
				const offset = operation.offset ?? 0;
				const selected = operation.version
					? await client.version(key.scope, key.name, operation.version)
					: undefined;
				return {
					package: operation.package,
					description: clean(value.description, 1024),
					keywords: value.keywords.slice(0, 20).map(value => clean(value, 50)),
					owners: value.owners.slice(0, 100).map(value => clean(value.username, 128)),
					tags: value.distTags,
					totalVersions: all.length,
					versions: all.slice(offset, offset + 50).map(version),
					...(offset + 50 < all.length ? { nextOffset: offset + 50 } : {}),
					...(selected
						? {
								selected: {
									version: version(selected),
									files: selected.files.map(({ path, size, executable }) => ({ path, size, executable })),
									publisher: clean(selected.provenance.publisher.username, 128),
									provenance: clean(
										selected.provenance.verified
											? `Verified ${selected.provenance.verified.repository} @ ${selected.provenance.verified.sha}`
											: selected.provenance.reported
												? `Reported OMP ${selected.provenance.reported.ompVersion}`
												: "No verified provenance",
										2000,
									),
								},
							}
						: {}),
				};
			});
		if (operation.kind === "skillshare.prepare") {
			if (this.#mutating)
				throw new SessionControlError("COMMAND_BLOCKED", "Wait for the current Skillshare action to finish");
			for (const [id, plan] of this.#plans)
				if (plan.state.state === "ready" && plan.review.expiresAt < Date.now()) this.#plans.delete(id);
			if (this.#plans.size >= 10)
				throw new SessionControlError("COMMAND_BLOCKED", "Discard old Skillshare reviews before creating another");
			const plan = await this.#prepare(operation.action, operation.sessionId, cwd);
			this.#assert(operation.sessionId, cwd);
			validateSkillshareResult("skillshare.prepare", { review: plan.review });
			this.#plans.set(plan.review.id, plan);
			return { review: plan.review };
		}
		const plan = this.#plans.get(operation.id);
		if (!plan || plan.sessionId !== operation.sessionId)
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"This Skillshare review is unavailable; inspect the registry before creating a new request",
			);
		if (operation.kind === "skillshare.action") return { action: plan.state };
		if (operation.kind === "skillshare.discard") {
			if (plan.state.state === "running")
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"A submitted registry action cannot be discarded while its result is unknown",
				);
			this.#plans.delete(operation.id);
			return { discarded: true };
		}
		if (plan.state.state !== "ready") return { action: plan.state };
		if (this.#mutating || operation.digest !== plan.review.digest || plan.review.expiresAt < Date.now())
			throw new SessionControlError("COMMAND_BLOCKED", "The review expired, changed, or another action is running");
		if (plan.review.scripts.length && !operation.allowScripts)
			throw new SessionControlError("COMMAND_BLOCKED", "Review and accept the listed script-bearing files");
		if (plan.review.secrets.length && !operation.allowSecrets)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Remove the suspected secrets or explicitly accept their publication",
			);
		this.#assert(plan.sessionId, plan.cwd);
		this.#mutating = true;
		plan.state.state = "running";
		plan.promise = this.#run(plan).finally(() => {
			this.#mutating = false;
			delete plan.pack;
			delete plan.zip;
		});
		void plan.promise.catch(() => {});
		return { action: plan.state };
	}
	async #local(cwd: string, name: string, directory: boolean): Promise<string> {
		const root = await realpath(cwd);
		const target = await realpath(resolve(root, name));
		const rel = relative(root, target);
		if (isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../"))
			throw new SessionControlError("INVALID_ARGUMENT", "Skillshare files must stay inside the active workspace");
		const stat = await lstat(target);
		if (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > 20 * 1024 * 1024)
			throw new SessionControlError("INVALID_ARGUMENT", "Choose a skill directory or a .skill archive up to 20 MiB");
		return target;
	}
	async #manifestFingerprint(paths: SkillsInstallPaths): Promise<string> {
		return hash(JSON.stringify(await Promise.all([readSkillsManifest(paths.manifest), readSkillsLock(paths.lock)])));
	}
	async #prepare(action: SkillshareAction, sessionId: string, cwd: string): Promise<Plan> {
		return this.#withClient(
			action.type === "publish" ||
				["tag.set", "tag.remove", "yank", "deprecate", "owner.add", "owner.remove"].includes(action.type),
			async client => {
				const review: SkillshareReview = {
					id: randomUUID(),
					digest: "",
					expiresAt: Date.now() + 600000,
					action: structuredClone(action),
					registry: client.registryUrl,
					remoteWrite: remoteAction(action.type),
					changes: [],
					files: [],
					filesTotal: 0,
					scripts: [],
					secrets: [],
					warnings: [],
				};
				const plan: Plan = {
					review,
					state: { id: review.id, type: action.type, state: "ready" },
					sessionId,
					cwd,
					packuments: new Map(),
					manifests: new Map(),
				};
				if (action.type === "install" || action.type === "update" || action.type === "uninstall") {
					const paths = await getSkillsInstallPaths({ global: action.scope === "user", cwd });
					plan.paths = paths;
					plan.manifestFingerprint = await this.#manifestFingerprint(paths);
					const [manifest, lock] = await Promise.all([
						readSkillsManifest(paths.manifest),
						readSkillsLock(paths.lock),
					]);
					const requested =
						action.type === "install" && action.specs.length
							? action.specs
							: action.type !== "install" && action.names.length
								? action.names
								: Object.keys(manifest.skills);
					if (requested.length > 50)
						throw new SessionControlError("INVALID_ARGUMENT", "Select at most 50 packages per reviewed action");
					for (const spec of requested) {
						const parsed = parseSkillSpec(spec);
						if (!parsed) throw new SessionControlError("INVALID_ARGUMENT", "Invalid registry package");
						const id = `@${parsed.scope}/${parsed.name}`;
						if (action.type === "uninstall") {
							review.changes.push({
								package: id,
								...(lock.skills[id] ? { from: lock.skills[id]!.version } : {}),
							});
							continue;
						}
						const packument = await client.packument(parsed.scope, parsed.name);
						plan.packuments.set(id, packument);
						const request =
							action.type === "install" && action.specs.length
								? (parsed.range ?? "latest")
								: action.type === "install" && lock.skills[id]
									? lock.skills[id]!.version
									: manifest.skills[id];
						if (!request)
							throw new SessionControlError(
								"INVALID_ARGUMENT",
								"The selected package is not listed in this scope's manifest",
							);
						const resolution = resolveSkillVersion(packument, request);
						const range =
							action.type === "install" && action.specs.length
								? (parsed.range ?? `^${resolution.version}`)
								: manifest.skills[id]!;
						const detail = await client.version(parsed.scope, parsed.name, resolution.version);
						if (detail.integrity !== resolution.summary.integrity)
							throw new SessionControlError(
								"COMMAND_BLOCKED",
								"Registry metadata changed while preparing; review again",
							);
						plan.manifests.set(id + "@" + resolution.version, detail);
						review.changes.push({
							package: id,
							...(lock.skills[id] ? { from: lock.skills[id]!.version } : {}),
							to: resolution.version,
							range,
							integrity: detail.integrity,
						});
						review.warnings.push(...resolution.warnings.map(value => clean(value, 2000)));
						for (const file of detail.files)
							if (file.executable || file.path.startsWith("scripts/"))
								review.scripts.push(id + "@" + detail.version + ": " + file.path);
					}
					review.warnings.push(
						"Installation stores code but does not run package scripts. Reload explicitly to refresh this session's skills.",
					);
				} else if (action.type === "version") {
					if (!this.#directory)
						throw new SessionControlError(
							"COMMAND_BLOCKED",
							"Version edits require the private desktop file channel",
						);
					plan.path = await this.#local(cwd, action.directory, true);
					const source = await readFile(await this.#local(cwd, join(action.directory, "SKILL.md"), false));
					if (source.length > 1024 * 1024)
						throw new SessionControlError("INVALID_ARGUMENT", "SKILL.md exceeds 1 MiB");
					review.sourceDigest = hash(source);
					review.files = [{ path: "SKILL.md", size: source.length, executable: false }];
					review.filesTotal = 1;
					const temporary = join(this.#directory, "skillshare", "version-preview", review.id);
					await mkdir(temporary, { recursive: true, mode: 0o700 });
					try {
						await writeFile(join(temporary, "SKILL.md"), source, { flag: "wx", mode: 0o600 });
						const next = await bumpVersion(temporary, action.bump);
						review.warnings.push(`Set SKILL.md metadata.version to ${next}. This does not publish.`);
					} finally {
						await unlink(join(temporary, "SKILL.md")).catch(() => {});
					}
				} else if (action.type === "publish") {
					plan.path = await this.#local(cwd, action.directory, true);
					plan.pack = await packSkill(plan.path);
					review.files = plan.pack.files;
					review.filesTotal = plan.pack.files.length;
					review.sourceDigest = hash(plan.pack.tgz);
					review.scripts = plan.pack.files
						.filter(file => file.executable || file.path.startsWith("scripts/"))
						.map(file => file.path);
					review.secrets = plan.pack.secrets.slice(0, 200);
					review.changes.push({
						package: `@${action.scope}/${plan.pack.name}`,
						to: plan.pack.version,
						integrity: plan.pack.integrity,
					});
					if (plan.pack.secrets.length > 200)
						review.warnings.push(
							`Found ${plan.pack.secrets.length} possible secrets; showing the first 200. Remove them before publishing.`,
						);
				} else if (action.type === "import") {
					plan.path = await this.#local(cwd, action.file, false);
					if (!plan.path.toLowerCase().endsWith(".skill"))
						throw new SessionControlError("INVALID_ARGUMENT", "Choose a Claude .skill archive");
					plan.zip = await readFile(plan.path);
					if (plan.zip[0] !== 0x50 || plan.zip[1] !== 0x4b)
						throw new SessionControlError("INVALID_ARGUMENT", "A .skill import must be a ZIP archive");
					review.sourceDigest = hash(plan.zip);
					review.files = [{ path: action.file, size: plan.zip.length, executable: false }];
					review.filesTotal = 1;
					review.warnings.push(
						"Import uploads and publishes the complete archive. The registry converts its contents and determines the package identity; inspect the archive before confirming.",
					);
				} else if ("package" in action) {
					const parsed = packageId(action.package);
					const current = await client.packument(parsed.scope, parsed.name);
					plan.packuments.set(action.package, current);
					if ("version" in action && !Object.hasOwn(current.versions, action.version))
						throw new SessionControlError("INVALID_ARGUMENT", "Choose an existing exact version");
					review.changes.push({
						package: action.package,
						...(action.type === "tag.set"
							? {
									...(current.distTags[action.tag] ? { from: current.distTags[action.tag] } : {}),
									to: action.version,
								}
							: "version" in action
								? { to: action.version }
								: {}),
					});
					if (action.type === "owner.remove")
						review.warnings.push(
							`Remove owner ${action.username}. Current owners: ${current.owners.map(owner => owner.username).join(", ")}`,
						);
					if (action.type === "tag.remove" && action.tag === "latest")
						throw new SessionControlError(
							"INVALID_ARGUMENT",
							"The native registry does not allow removing latest",
						);
				} else if (action.type === "token.create") {
					if (!this.#directory)
						throw new SessionControlError(
							"COMMAND_BLOCKED",
							"Creating tokens requires the private desktop secret handoff",
						);
					review.warnings.push(
						action.packages.length
							? "This token can publish only the listed packages."
							: "This token can publish every package its creator manages.",
					);
					review.warnings.push(
						"The secret is shown once through the desktop channel and is not saved automatically. The handoff expires after two minutes.",
					);
				} else if (action.type === "token.revoke") {
					const tokens = await client.listTokens();
					const selected = tokens.find(token => token.id === action.id);
					if (!selected) throw new SessionControlError("INVALID_ARGUMENT", "Select an existing token");
					review.warnings.push(
						`Revoke ${clean(selected.name, 128)} (${selected.id}). Clients using it will lose access.`,
					);
				} else
					review.warnings.push(
						"Rediscover skills and refresh prompt metadata in this session; no prompt is sent.",
					);
				review.digest = hash(JSON.stringify(review));
				return plan;
			},
		);
	}
	async #backup(plan: Plan): Promise<void> {
		if (!this.#directory)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Local mutations require the private desktop backup directory",
			);
		const directory = join(this.#directory, "skillshare", "backups", plan.review.id);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const paths = plan.paths
			? [plan.paths.manifest, plan.paths.lock]
			: plan.path && plan.review.action.type === "version"
				? [join(plan.path, "SKILL.md")]
				: [];
		for (const [index, file] of paths.entries()) {
			const bytes = await readFile(file).catch(error => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (bytes) await writeFile(join(directory, index + ".original"), bytes, { flag: "wx", mode: 0o600 });
		}
		await writeFile(
			join(directory, "restore.json"),
			JSON.stringify({ paths, reason: plan.review.action.type, createdAt: new Date().toISOString() }),
			{ flag: "wx", mode: 0o600 },
		);
	}
	async #run(plan: Plan): Promise<void> {
		const action = plan.review.action;
		let submitted = false;
		try {
			this.#assert(plan.sessionId, plan.cwd);
			if (plan.paths && (await this.#manifestFingerprint(plan.paths)) !== plan.manifestFingerprint)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Local manifests changed; discard this review and prepare again",
				);
			if (plan.pack && plan.path) {
				const current = await packSkill(
					await this.#local(plan.cwd, (action as { directory: string }).directory, true),
				);
				if (hash(current.tgz) !== plan.review.sourceDigest)
					throw new SessionControlError("COMMAND_BLOCKED", "The packed files changed after review; prepare again");
			}
			if (
				action.type === "version" &&
				hash(await readFile(await this.#local(plan.cwd, join(action.directory, "SKILL.md"), false))) !==
					plan.review.sourceDigest
			)
				throw new SessionControlError("COMMAND_BLOCKED", "SKILL.md changed after review");
			if (
				action.type === "import" &&
				plan.zip &&
				plan.path &&
				hash(await readFile(await this.#local(plan.cwd, action.file, false))) !== plan.review.sourceDigest
			)
				throw new SessionControlError("COMMAND_BLOCKED", "The import archive changed after review");
			if (plan.paths || action.type === "version") await this.#backup(plan);
			await this.#withClient(
				action.type === "publish" ||
					["tag.set", "tag.remove", "yank", "deprecate", "owner.add", "owner.remove"].includes(action.type),
				async client => {
					if (client.registryUrl !== plan.review.registry)
						throw new SessionControlError("COMMAND_BLOCKED", "Registry changed after review");
					this.#assert(plan.sessionId, plan.cwd);
					const frozen = new Proxy(client, {
						get(target, key) {
							if (key === "packument")
								return async (scope: string, name: string) => {
									const value = plan.packuments.get(`@${scope}/${name}`);
									if (!value) throw new Error("Unreviewed package requested");
									return structuredClone(value);
								};
							if (key === "version")
								return async (scope: string, name: string, version: string) => {
									const value = plan.manifests.get(`@${scope}/${name}@${version}`);
									if (!value) throw new Error("Unreviewed version requested");
									return structuredClone(value);
								};
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					const hooks = {
						confirmScripts: async (request: { id: string; version: string }) =>
							plan.manifests.has(request.id + "@" + request.version),
						warn: () => {},
					};
					submitted = true;
					if (action.type === "install")
						await (this.dependencies.install ?? installSkillPackages)(
							frozen,
							{ specs: action.specs, cwd: plan.cwd, global: action.scope === "user", yes: false },
							hooks,
						);
					else if (action.type === "update")
						await (this.dependencies.update ?? updateSkillPackages)(
							frozen,
							{ names: action.names, cwd: plan.cwd, global: action.scope === "user", yes: false },
							hooks,
						);
					else if (action.type === "uninstall")
						await (this.dependencies.uninstall ?? uninstallSkillPackages)({
							names: action.names,
							cwd: plan.cwd,
							global: action.scope === "user",
						});
					else if (action.type === "version") await bumpVersion(plan.path!, action.bump);
					else if (action.type === "reload") await this.session.refreshSkills();
					else if (action.type === "publish") {
						const result = await client.publish(
							action.scope,
							plan.pack!.name,
							plan.pack!.version,
							plan.pack!.tgz,
							{ ...(action.tag ? { tag: action.tag } : {}), provenance: { ompVersion: "18.3.0" } },
						);
						plan.state.link = result.url;
					} else if (action.type === "import") {
						const result = await client.importSkill(plan.zip!);
						plan.state.link = result.url;
					} else if (action.type === "token.revoke") await client.revokeToken(action.id);
					else if (action.type === "token.create") {
						const result = await client.createToken({
							name: action.name,
							...(action.packages.length ? { packages: action.packages } : {}),
							...(action.expiresInDays ? { expiresInDays: action.expiresInDays } : {}),
						});
						if (
							typeof result.token !== "string" ||
							!result.token.startsWith("sks_") ||
							result.token.length > 4096
						)
							throw new Error("Invalid token response");
						const id = randomUUID();
						const directory = join(this.#directory!, "skillshare", "secrets");
						await mkdir(directory, { recursive: true, mode: 0o700 });
						const file = join(directory, id + ".json");
						await writeFile(
							file,
							JSON.stringify({
								sessionId: plan.sessionId,
								expiresAt: Date.now() + 120000,
								token: result.token,
								name: clean(result.name, 128),
							}),
							{ flag: "wx", mode: 0o600 },
						);
						this.#secretFiles.add(file);
						const timer = setTimeout(() => {
							this.#secretFiles.delete(file);
							void unlink(file).catch(() => {});
						}, 120000);
						timer.unref?.();
						plan.state.secretId = id;
					} else {
						const parsed = packageId(action.package);
						if (action.type === "tag.set")
							await client.setTag(parsed.scope, parsed.name, action.tag, action.version);
						else if (action.type === "tag.remove") await client.removeTag(parsed.scope, parsed.name, action.tag);
						else if (action.type === "yank")
							await client.yank(parsed.scope, parsed.name, action.version, action.yanked);
						else if (action.type === "deprecate")
							await client.deprecate(parsed.scope, parsed.name, action.version, action.message);
						else if (action.type === "owner.add")
							await client.addOwner(parsed.scope, parsed.name, action.username);
						else await client.removeOwner(parsed.scope, parsed.name, action.username);
					}
				},
			);
			plan.state.state = "completed";
			plan.state.message =
				action.type === "token.create"
					? "Token created. Open the one-time desktop reveal now, or revoke it if the secret was not received."
					: ["install", "update", "uninstall"].includes(action.type)
						? "Local package manifests updated. Refresh skills explicitly to load the changed inventory."
						: "The reviewed action completed.";
			validateSkillshareResult("skillshare.action", { action: plan.state });
		} catch (cause) {
			plan.state.state =
				submitted &&
				remoteAction(action.type) &&
				!(cause instanceof SkillshareError && [400, 401, 403, 404, 409, 422].includes(cause.status))
					? "uncertain"
					: "failed";
			plan.state.message =
				plan.state.state === "uncertain"
					? "The registry may have accepted this request. Check its state before creating another review; Studio will not retry automatically."
					: cause instanceof SessionControlError
						? clean(cause.message, 2000)
						: cause instanceof SkillshareError
							? `Registry rejected the action (HTTP ${cause.status}). Check account, ownership and version.`
							: "The action failed. Check package metadata, local manifests and the registry before preparing again.";
		}
	}
}
