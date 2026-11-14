export type SkillshareAction =
	| { type: "install"; specs: string[]; scope: "project" | "user" }
	| { type: "update"; names: string[]; scope: "project" | "user" }
	| { type: "uninstall"; names: string[]; scope: "project" | "user" }
	| { type: "publish"; directory: string; scope: string; tag?: string }
	| { type: "import"; file: string }
	| { type: "version"; directory: string; bump: string }
	| { type: "tag.set"; package: string; tag: string; version: string }
	| { type: "tag.remove"; package: string; tag: string }
	| { type: "yank"; package: string; version: string; yanked: boolean }
	| { type: "deprecate"; package: string; version: string; message: string | null }
	| { type: "owner.add"; package: string; username: string }
	| { type: "owner.remove"; package: string; username: string }
	| { type: "token.create"; name: string; packages: string[]; expiresInDays?: number }
	| { type: "token.revoke"; id: string }
	| { type: "reload" };
export interface SkillshareHit {
	package: string;
	description: string;
	version: string;
	downloads: number;
	updatedAt: number;
	deprecated?: string;
}
export interface SkillshareVersion {
	version: string;
	integrity: string;
	bytes: number;
	fileCount: number;
	hasScripts: boolean;
	yanked: boolean;
	deprecated?: string;
	publishedAt: number;
}
export interface SkillshareFile {
	path: string;
	size: number;
	executable: boolean;
}
export interface SkillshareToken {
	id: string;
	name: string;
	packages: string[];
	createdAt: number;
	expiresAt?: number;
	lastUsedAt?: number;
}
export interface SkillshareInstalled {
	package: string;
	scope: "project" | "user";
	range?: string;
	version?: string;
	stored: boolean;
}
export interface SkillshareReview {
	id: string;
	digest: string;
	expiresAt: number;
	action: SkillshareAction;
	registry: string;
	remoteWrite: boolean;
	changes: Array<{ package: string; from?: string; to?: string; range?: string; integrity?: string }>;
	files: SkillshareFile[];
	filesTotal: number;
	scripts: string[];
	secrets: Array<{ path: string; line: number; kind: string }>;
	warnings: string[];
	sourceDigest?: string;
}
export interface SkillshareActionState {
	id: string;
	type: SkillshareAction["type"];
	state: "ready" | "running" | "completed" | "failed" | "uncertain";
	message?: string;
	secretId?: string;
	link?: string;
}
export type SkillshareOperation =
	| { kind: "skillshare.status"; sessionId: string }
	| { kind: "skillshare.home"; sessionId: string }
	| {
			kind: "skillshare.search";
			sessionId: string;
			query: string;
			sort?: "relevance" | "downloads" | "recent";
			page?: number;
	  }
	| { kind: "skillshare.package"; sessionId: string; package: string; version?: string; offset?: number }
	| { kind: "skillshare.installed"; sessionId: string; offset?: number }
	| { kind: "skillshare.tokens"; sessionId: string }
	| { kind: "skillshare.prepare"; sessionId: string; action: SkillshareAction }
	| {
			kind: "skillshare.execute";
			sessionId: string;
			id: string;
			digest: string;
			allowScripts: boolean;
			allowSecrets: boolean;
	  }
	| { kind: "skillshare.action"; sessionId: string; id: string }
	| { kind: "skillshare.discard"; sessionId: string; id: string };
export interface SkillshareResultMap {
	"skillshare.status": {
		registry: string;
		accountAuthenticated: boolean;
		publishAuthenticated: boolean;
		privateTokenChannel: boolean;
		actions: SkillshareActionState[];
	};
	"skillshare.home": {
		stats: { packages: number; versions: number; publishers: number; weeklyDownloads: number };
		recent: SkillshareHit[];
		popular: SkillshareHit[];
		trending: SkillshareHit[];
	};
	"skillshare.search": { hits: SkillshareHit[]; total: number; page: number; perPage: number };
	"skillshare.package": {
		package: string;
		description: string;
		keywords: string[];
		owners: string[];
		tags: Record<string, string>;
		versions: SkillshareVersion[];
		totalVersions: number;
		nextOffset?: number;
		selected?: { version: SkillshareVersion; files: SkillshareFile[]; publisher: string; provenance: string };
	};
	"skillshare.installed": { skills: SkillshareInstalled[]; total: number; nextOffset?: number };
	"skillshare.tokens": { tokens: SkillshareToken[] };
	"skillshare.prepare": { review: SkillshareReview };
	"skillshare.execute": { action: SkillshareActionState };
	"skillshare.action": { action: SkillshareActionState };
	"skillshare.discard": { discarded: boolean };
}
export const SKILLSHARE_OPERATION_KINDS = [
	"skillshare.status",
	"skillshare.home",
	"skillshare.search",
	"skillshare.package",
	"skillshare.installed",
	"skillshare.tokens",
	"skillshare.prepare",
	"skillshare.execute",
	"skillshare.action",
	"skillshare.discard",
] as const;
export function isSkillshareOperationKind(kind: string): kind is SkillshareOperation["kind"] {
	return (SKILLSHARE_OPERATION_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Skillshare fields");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 512, empty = false): asserts value is string {
	if (typeof value !== "string" || (!empty && !value.trim()) || /[\u0000-\u001f]/u.test(value) || value.length > max)
		throw new Error("Invalid Skillshare text");
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
		throw new Error("Invalid Skillshare number");
}
function id(value: unknown): void {
	text(value, 36);
	if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid review id");
}
function digest(value: unknown): void {
	text(value, 64);
	if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid review digest");
}
function pkg(value: unknown, range = false): void {
	text(value, 256);
	if (
		!(
			range
				? /^@[a-z0-9][a-z0-9_]{2,31}\/[a-z0-9]+(?:-[a-z0-9]+)*(?:@[^\r\n]+)?$/u
				: /^@[a-z0-9][a-z0-9_]{2,31}\/[a-z0-9]+(?:-[a-z0-9]+)*$/u
		).test(value)
	)
		throw new Error("Use @scope/name");
}
function list(value: unknown, max: number, item: (value: unknown) => void): asserts value is unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new Error("Skillshare list exceeds its limit");
	value.forEach(item);
}
function relative(value: unknown): void {
	text(value, 1024);
	if (/^(?:[A-Za-z]:|[/\\])/u.test(value) || value.split(/[/\\]/u).includes(".."))
		throw new Error("Use a workspace-relative path");
}
export function validateSkillshareAction(value: unknown): asserts value is SkillshareAction {
	const type = (value as { type?: string } | null)?.type;
	const fields: Record<string, string[]> = {
		install: ["specs", "scope"],
		update: ["names", "scope"],
		uninstall: ["names", "scope"],
		publish: ["directory", "scope", "tag"],
		import: ["file"],
		version: ["directory", "bump"],
		"tag.set": ["package", "tag", "version"],
		"tag.remove": ["package", "tag"],
		yank: ["package", "version", "yanked"],
		deprecate: ["package", "version", "message"],
		"owner.add": ["package", "username"],
		"owner.remove": ["package", "username"],
		"token.create": ["name", "packages", "expiresInDays"],
		"token.revoke": ["id"],
		reload: [],
	};
	if (!type || !Object.hasOwn(fields, type)) throw new Error("Unknown Skillshare action");
	const row = object(value);
	for (const key of fields[type]!) {
		const field = row[key];
		if (
			["tag", "expiresInDays"].includes(key) &&
			field === undefined &&
			(type === "publish" || type === "token.create")
		)
			continue;
		if (key === "scope") {
			text(field, 32);
			if (type === "publish" ? !/^[a-z0-9][a-z0-9_]{2,31}$/u.test(field) : !["project", "user"].includes(field))
				throw new Error("Invalid Skillshare scope");
		} else if (["specs", "names", "packages"].includes(key)) {
			list(field, 50, item => pkg(item, key === "specs"));
			if (type === "uninstall" && !field.length) throw new Error("Select packages to uninstall");
		} else if (key === "package") pkg(field);
		else if (key === "directory" || key === "file") relative(field);
		else if (key === "yanked") {
			if (typeof field !== "boolean") throw new Error("Invalid yank flag");
		} else if (key === "expiresInDays") {
			number(field, 3650);
			if (!field) throw new Error("Expiry must be positive");
		} else if (key === "message" && field === null) continue;
		else {
			text(field, key === "message" ? 500 : 128, key === "message");
			if (key === "tag" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(field)) throw new Error("Invalid dist-tag");
		}
	}
}
export function validateSkillshareOperation(value: unknown): asserts value is SkillshareOperation {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !isSkillshareOperationKind(kind)) throw new Error("Unknown Skillshare operation");
	const extras =
		kind === "skillshare.search"
			? ["query", "sort", "page"]
			: kind === "skillshare.package"
				? ["package", "version", "offset"]
				: kind === "skillshare.installed"
					? ["offset"]
					: kind === "skillshare.prepare"
						? ["action"]
						: kind === "skillshare.execute"
							? ["id", "digest", "allowScripts", "allowSecrets"]
							: ["skillshare.action", "skillshare.discard"].includes(kind)
								? ["id"]
								: [];
	const row = object(value);
	text(row.sessionId);
	if (kind === "skillshare.search") {
		text(row.query, 512, true);
		if (row.sort !== undefined && !["relevance", "downloads", "recent"].includes(row.sort as string))
			throw new Error("Invalid search sort");
	}
	for (const key of ["offset", "page"]) if (row[key] !== undefined) number(row[key], 100000);
	if (kind === "skillshare.package") pkg(row.package);
	if (row.version !== undefined) text(row.version, 128);
	if (kind === "skillshare.prepare") validateSkillshareAction(row.action);
	if (extras.includes("id")) id(row.id);
	if (kind === "skillshare.execute") {
		digest(row.digest);
		if (typeof row.allowScripts !== "boolean" || typeof row.allowSecrets !== "boolean")
			throw new Error("Explicit script/secret decisions are required");
	}
}
