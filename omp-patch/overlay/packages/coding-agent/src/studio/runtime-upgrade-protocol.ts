/** Typed capabilities added with the OMP 18.2 migration. Kept wire-only. */
export type ForeignSource = "claude" | "codex";
export type RuntimeAuthProvider = "typesafe" | "exa" | "ollama-cloud";
export type UpgradeOperation =
	| { kind: "btw.history.list" }
	| { kind: "btw.history.read"; topicId: string }
	| { kind: "btw.followUp"; topicId: string; question: string }
	| { kind: "session.models.mentions" }
	| { kind: "session.import.list"; source: ForeignSource }
	| { kind: "session.import.preview"; source: ForeignSource; sourceId: string }
	| {
			kind: "session.import.execute";
			source: ForeignSource;
			sourceId: string;
			fallbackCwd?: string;
			fallbackWorkspaceId?: string;
	  }
	| { kind: "runtime.auth.get"; provider: RuntimeAuthProvider }
	| { kind: "runtime.auth.set"; provider: RuntimeAuthProvider; apiKey: string }
	| { kind: "runtime.auth.remove"; provider: RuntimeAuthProvider };
export const UPGRADE_OPERATION_KINDS = [
	"btw.history.list",
	"btw.history.read",
	"btw.followUp",
	"session.models.mentions",
	"session.import.list",
	"session.import.preview",
	"session.import.execute",
	"runtime.auth.get",
	"runtime.auth.set",
	"runtime.auth.remove",
] as const;
export function isUpgradeOperationKind(kind: string): kind is UpgradeOperation["kind"] {
	return (UPGRADE_OPERATION_KINDS as readonly string[]).includes(kind);
}
export interface BtwHistoryTurn {
	question: string;
	answer: string;
	status: "running" | "complete" | "cancelled" | "error" | "interrupted";
	createdAt: number;
	updatedAt: number;
	error?: string;
}
export interface BtwTopicSummary {
	topicId: string;
	question: string;
	status: BtwHistoryTurn["status"];
	updatedAt: number;
	turnCount: number;
}
export interface ForeignSessionSummary {
	source: ForeignSource;
	sourceId: string;
	title: string;
	directoryName: string;
	cwdExists: boolean;
	modifiedAt: string;
	messageCount?: number;
	firstMessage?: string;
}
export interface ModelMentionInfo {
	agent: string;
	selector: string;
	name: string;
}
export interface UpgradeResultMap {
	"btw.history.list": { sessionId: string; topics: BtwTopicSummary[] };
	"btw.history.read": { sessionId: string; topicId: string; turns: BtwHistoryTurn[] };
	"btw.followUp": { ephemeralId: string; status: "running" };
	"session.models.mentions": {
		sessionId: string;
		mentions: ModelMentionInfo[];
		available: Array<{ selector: string; name: string; image: boolean }>;
		activeModelImage: boolean;
	};
	"session.import.list": { sessions: ForeignSessionSummary[] };
	"session.import.preview": { session: ForeignSessionSummary; preview: string };
	/**
	 * Public shape after the desktop Host rewrite: the Runtime returns
	 * `{ imported, sessionId, cwd }` and the Host maps `cwd` onto a registered
	 * `workspaceId` (apps/desktop/src/session-commands.ts). Do not validate the
	 * Runtime dispatch path with `validateUpgradeResult` for this kind — it
	 * would reject the Runtime's own pre-rewrite output.
	 */
	"session.import.execute": { imported: true; sessionId: string; workspaceId: string };
	"runtime.auth.get": {
		provider: RuntimeAuthProvider;
		configured: boolean;
		lastJudgment?: { purpose: string; provider: string; model: string };
	};
	"runtime.auth.set": {
		provider: RuntimeAuthProvider;
		configured: boolean;
		lastJudgment?: { purpose: string; provider: string; model: string };
	};
	"runtime.auth.remove": {
		provider: RuntimeAuthProvider;
		configured: boolean;
		lastJudgment?: { purpose: string; provider: string; model: string };
	};
}
export function validateUpgradeOperation(value: unknown): asserts value is UpgradeOperation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Runtime operation");
	const op = value as Record<string, unknown>;
	if (typeof op.kind !== "string" || !isUpgradeOperationKind(op.kind)) throw new Error("Unknown Runtime operation");
	const fields: Record<UpgradeOperation["kind"], string[]> = {
		"btw.history.list": [],
		"btw.history.read": ["topicId"],
		"btw.followUp": ["topicId", "question"],
		"session.models.mentions": [],
		"session.import.list": ["source"],
		"session.import.preview": ["source", "sourceId"],
		"session.import.execute": ["source", "sourceId", "fallbackCwd", "fallbackWorkspaceId"],
		"runtime.auth.get": ["provider"],
		"runtime.auth.set": ["provider", "apiKey"],
		"runtime.auth.remove": ["provider"],
	};
	if (Object.keys(op).some(key => key !== "kind" && !fields[op.kind as UpgradeOperation["kind"]].includes(key)))
		throw new Error("Unknown Runtime operation field");
	for (const key of fields[op.kind as UpgradeOperation["kind"]]) {
		if ((key === "fallbackCwd" || key === "fallbackWorkspaceId") && op[key] === undefined) continue;
		const text = op[key];
		const limit = key === "question" ? 65536 : key === "apiKey" ? 16384 : key === "fallbackCwd" ? 4096 : 512;
		if (typeof text !== "string" || !text.trim() || text.length > limit || text.includes("\0"))
			throw new Error("Invalid Runtime operation field: " + key);
	}
	if ("source" in op && op.source !== "claude" && op.source !== "codex") throw new Error("Invalid import source");
	if ("provider" in op && !["typesafe", "exa", "ollama-cloud"].includes(op.provider as string))
		throw new Error("Invalid authentication provider");
}

/** Validate results at the IPC boundary; credentials and native replay payloads have no public field. */
export function validateUpgradeResult(kind: UpgradeOperation["kind"], value: unknown): void {
	type Check = (value: unknown) => void;
	const text: Check = v => {
		if (typeof v !== "string" || v.length > 262144) throw new Error("Invalid text result");
	};
	const short: Check = v => {
		text(v);
		if ((v as string).length > 4096) throw new Error("Oversized identifier");
	};
	const number: Check = v => {
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("Invalid numeric result");
	};
	const bool: Check = v => {
		if (typeof v !== "boolean") throw new Error("Invalid boolean result");
	};
	const enumeration =
		(values: readonly string[]): Check =>
		v => {
			if (typeof v !== "string" || !values.includes(v)) throw new Error("Invalid result enum");
		};
	const array =
		(check: Check, max = 200): Check =>
		v => {
			if (!Array.isArray(v) || v.length > max) throw new Error("Invalid list result");
			v.forEach(check);
		};
	const shape =
		(fields: Record<string, Check>): Check =>
		v => {
			if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid object result");
			const obj = v as Record<string, unknown>;
			if (Object.keys(obj).some(key => !(key in fields) && !(key + "?" in fields)))
				throw new Error("Unknown result field");
			for (const [field, check] of Object.entries(fields)) {
				const optional = field.endsWith("?");
				const key = optional ? field.slice(0, -1) : field;
				if (optional && obj[key] === undefined) continue;
				check(obj[key]);
			}
		};
	const status = enumeration(["running", "complete", "cancelled", "error", "interrupted"]);
	const summary = shape({
		source: enumeration(["claude", "codex"]),
		sourceId: short,
		title: short,
		directoryName: short,
		cwdExists: bool,
		modifiedAt: short,
		"messageCount?": number,
		"firstMessage?": short,
	});
	const checks: Record<UpgradeOperation["kind"], Check> = {
		"btw.history.list": shape({
			sessionId: short,
			topics: array(shape({ topicId: short, question: short, status, updatedAt: number, turnCount: number }), 100),
		}),
		"btw.history.read": shape({
			sessionId: short,
			topicId: short,
			turns: array(
				shape({ question: text, answer: text, status, createdAt: number, updatedAt: number, "error?": short }),
				32,
			),
		}),
		"btw.followUp": shape({ ephemeralId: short, status: enumeration(["running"]) }),
		"session.models.mentions": shape({
			sessionId: short,
			mentions: array(shape({ agent: short, selector: short, name: short }), 1024),
			available: array(shape({ selector: short, name: short, image: bool }), 10000),
			activeModelImage: bool,
		}),
		"session.import.list": shape({ sessions: array(summary) }),
		"session.import.preview": shape({ session: summary, preview: text }),
		"session.import.execute": shape({
			imported: v => {
				if (v !== true) throw new Error("Invalid import result");
			},
			sessionId: short,
			workspaceId: short,
		}),
		"runtime.auth.get": shape({
			provider: enumeration(["typesafe", "exa", "ollama-cloud"]),
			configured: bool,
			"lastJudgment?": shape({ purpose: short, provider: short, model: short }),
		}),
		"runtime.auth.set": shape({
			provider: enumeration(["typesafe", "exa", "ollama-cloud"]),
			configured: bool,
			"lastJudgment?": shape({ purpose: short, provider: short, model: short }),
		}),
		"runtime.auth.remove": shape({
			provider: enumeration(["typesafe", "exa", "ollama-cloud"]),
			configured: bool,
			"lastJudgment?": shape({ purpose: short, provider: short, model: short }),
		}),
	};
	checks[kind](value);
}
