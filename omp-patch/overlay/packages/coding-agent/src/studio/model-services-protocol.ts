import type { RuntimeModelChoice } from "./workbench-protocol";
import type { AccountResetPolicy, AccountResetPolicyKey } from "./accounts-protocol";
import { runtimeText } from "./locale";

export interface ModelSystemPromptSelection {
	source:
		| "bundled"
		| "explicit-template"
		| "explicit-text"
		| "discovered-template"
		| "discovered-text"
		| "model-template";
	path?: string;
	pattern?: string;
	matchedTemplate?: { pattern: string; path: string };
	fallback?: "missing" | "empty" | "invalid";
}
export interface ModelSystemTemplateBinding {
	pattern: string;
	file: string;
	source: "global" | "project" | "overlay" | "runtime";
	editable: boolean;
	effective: boolean;
}
export interface ModelSystemTemplatesList {
	sessionId: string;
	version: string;
	bindings: ModelSystemTemplateBinding[];
}
export interface ModelSystemTemplateFile {
	pattern: string;
	file: string;
	version: string;
	content: string;
	exists: boolean;
	editable: boolean;
}
export interface ModelSystemTemplateWriteResult {
	pattern: string;
	file: string;
	version: string;
	saved: true;
}
export interface ModelSystemTemplateInspection {
	selector: string;
	selection: ModelSystemPromptSelection;
	preview: string;
	live?: { selection?: ModelSystemPromptSelection; content: string; matchesPreview: boolean };
	truncated: boolean;
}
export interface ModelAuthProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
	kind: "api-key" | "oauth";
	credentials: Array<{ id: number; label: string; type: "api_key" | "oauth" }>;
	warning?: string;
	paused?: boolean;
	pauseReason?: string;
}
export interface ModelAuthProvidersResult {
	sessionId: string;
	providers: ModelAuthProvider[];
}
export interface ModelAuthLoginResult {
	providerId: string;
	authenticated: boolean;
	cancelled: boolean;
}
export type RuntimeModelEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** Public native thinking metadata, not a models.yml override or a resolved request. */
export interface RuntimeModelThinking {
	mode: "effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort";
	efforts: readonly RuntimeModelEffort[];
	defaultLevel?: RuntimeModelEffort;
	effortMap?: Partial<Record<RuntimeModelEffort, string>>;
	supportsDisplay?: boolean;
	prefixBinding?: boolean;
	effortRouting?: Readonly<Partial<Record<RuntimeModelEffort | "off", string>>>;
	effortBudgets?: Readonly<Partial<Record<RuntimeModelEffort, number>>>;
	suppressWhenOff?: boolean;
	requiresEffort?: boolean;
	unverified?: boolean;
}
export interface RuntimeModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}
export interface RuntimeModelLongContextCost extends RuntimeModelCost {
	inputThreshold: number;
	inputThresholdInclusive?: boolean;
}
export interface RuntimeModelPricing {
	longContext?: RuntimeModelLongContextCost;
	timeBased?: {
		offPeakMultiplier: number;
		peakWindows: readonly { weekdays: readonly number[]; startMinute: number; endMinute: number }[];
		effectiveRates?: readonly (RuntimeModelCost & {
			effectiveFrom: number;
			longContext?: RuntimeModelLongContextCost;
		})[];
	};
}
export interface RuntimeModelDiscovery {
	status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
	source?: "bundled" | "cache" | "models.dev" | "provider";
	stale: boolean;
	optional: boolean;
	fetchedAt?: number;
}
export interface ModelRosterEntry extends RuntimeModelChoice {
	id?: string;
	api: string;
	source?: "registry";
	providerType?: string;
	tools?: boolean;
	input?: readonly ("text" | "image")[];
	supportsComputerUse?: boolean;
	hostedImage?: boolean;
	maxContextWindow?: number;
	imageCountBudget?: number;
	thinking?: readonly RuntimeModelEffort[];
	thinkingConfig?: RuntimeModelThinking;
	cost?: RuntimeModelCost;
	pricing?: RuntimeModelPricing;
	pricingStatus?: "fixed" | "free" | "included" | "variable" | "unknown";
	serviceTierCost?: Readonly<Partial<Record<"flex" | "priority" | "ultrafast", number>>>;
	discovery?: RuntimeModelDiscovery;
	description?: string;
	isNew?: boolean;
	isBeta?: boolean;
	isProviderDefault?: boolean;
	isRecommended?: boolean;
}
export interface RuntimeAvailableModel extends ModelRosterEntry {
	id: string;
	source: "registry";
}
export interface ModelAvailableReadInput {
	sessionId: string;
	cursor?: string;
	providers?: string[];
	limit?: number;
}
export interface ModelAvailableReleaseInput {
	sessionId: string;
	snapshotId: string;
}
/** Refresh completion only; available rows and provider discovery status stay in transient reads. */
export interface ModelAvailableRefreshResult {
	sessionId: string;
	refreshed: true;
}
export type ModelAvailableOperation =
	| ({ kind: "models.available.read" } & ModelAvailableReadInput)
	| ({ kind: "models.available.release" } & ModelAvailableReleaseInput);
export interface ModelAvailablePage {
	sessionId: string;
	snapshotId: string;
	version: string;
	expiresAt: number;
	cursor: string;
	nextCursor?: string;
	total: number;
	truncated: boolean;
	models: RuntimeAvailableModel[];
}
export interface ModelProviderRoster {
	total?: number;
	truncated?: boolean;
	providerId: string;
	authenticated: boolean;
	authoritative: boolean;
	status: "ready" | "unavailable" | "error";
	error?: string;
	models: ModelRosterEntry[];
}
export interface ModelAntigravityReadiness {
	providerId: "antigravity-cli";
	installed: boolean;
	authenticated: boolean;
	bridgeReady: boolean;
	status: "not-installed" | "not-authenticated" | "bridge-unavailable" | "ready" | "error";
	version?: string;
	source?: "managed" | "override";
	error?: string;
}
export interface ModelServicesQueryInputMap {
	"models.antigravity.readiness": { sessionId: string };
	"models.available.read": ModelAvailableReadInput;
	"models.available.release": ModelAvailableReleaseInput;
	"models.systemTemplates.list": { sessionId: string };
	"models.systemTemplates.inspect": { sessionId: string; selector: string };
	"models.systemTemplates.file.read": { sessionId: string; pattern: string };
	"models.auth.providers.read": { sessionId: string };
}
export interface ModelServicesQueryResultMap {
	"models.antigravity.readiness": ModelAntigravityReadiness;
	"models.available.read": ModelAvailablePage;
	"models.available.release": { released: boolean };
	"models.systemTemplates.list": ModelSystemTemplatesList;
	"models.systemTemplates.inspect": ModelSystemTemplateInspection;
	"models.systemTemplates.file.read": ModelSystemTemplateFile;
	"models.auth.providers.read": ModelAuthProvidersResult;
}
export interface ModelServicesCommandInputMap {
	"models.available.refresh": { sessionId: string };
	"models.systemTemplates.binding.set": {
		sessionId: string;
		version: string;
		pattern: string;
		previousPattern?: string;
		file: string | null;
	};
	"models.systemTemplates.file.write": { sessionId: string; pattern: string; version: string; content: string };
	"models.auth.login": { sessionId: string; providerId: string };
	"models.auth.cancel": { sessionId: string; providerId: string };
	"models.auth.key.set": { sessionId: string; providerId: string; apiKey: string };
	"models.auth.key.remove": { sessionId: string; providerId: string; credentialId: number };
	"models.auth.unpause": { sessionId: string; providerId: string; scope: "global"; confirmed: true };
	"models.provider.roster.refresh": { sessionId: string; providerId: string };
	"models.accounts.resetPolicy.set": {
		sessionId: string;
		key: AccountResetPolicyKey;
		mode: AccountResetPolicy["mode"];
	};
}
export interface ModelServicesCommandResultMap {
	"models.available.refresh": ModelAvailableRefreshResult;
	"models.systemTemplates.binding.set": ModelSystemTemplatesList;
	"models.systemTemplates.file.write": ModelSystemTemplateWriteResult;
	"models.auth.login": ModelAuthLoginResult;
	"models.auth.cancel": { cancelled: boolean };
	"models.auth.key.set": ModelAuthProvidersResult;
	"models.auth.key.remove": ModelAuthProvidersResult;
	"models.auth.unpause": ModelAuthProvidersResult;
	"models.provider.roster.refresh": ModelProviderRoster;
	"models.accounts.resetPolicy.set": AccountResetPolicy;
}
export type ModelServicesOperation =
	| {
			[K in keyof ModelServicesQueryInputMap]: { kind: K } & ModelServicesQueryInputMap[K];
	  }[keyof ModelServicesQueryInputMap]
	| {
			[K in keyof ModelServicesCommandInputMap]: { kind: K } & ModelServicesCommandInputMap[K];
	  }[keyof ModelServicesCommandInputMap];

export const MODEL_SERVICES_QUERY_KINDS = [
	"models.available.read",
	"models.available.release",
	"models.antigravity.readiness",
	"models.systemTemplates.list",
	"models.systemTemplates.inspect",
	"models.systemTemplates.file.read",
	"models.auth.providers.read",
] as const satisfies readonly (keyof ModelServicesQueryInputMap)[];
export const MODEL_SERVICES_COMMAND_KINDS = [
	"models.available.refresh",
	"models.systemTemplates.binding.set",
	"models.systemTemplates.file.write",
	"models.auth.login",
	"models.auth.cancel",
	"models.auth.key.set",
	"models.auth.key.remove",
	"models.auth.unpause",
	"models.provider.roster.refresh",
	"models.accounts.resetPolicy.set",
] as const satisfies readonly (keyof ModelServicesCommandInputMap)[];
export function isModelServicesQueryKind(kind: string): kind is keyof ModelServicesQueryInputMap {
	return (MODEL_SERVICES_QUERY_KINDS as readonly string[]).includes(kind);
}
export function isModelServicesKind(kind: string): kind is ModelServicesOperation["kind"] {
	return isModelServicesQueryKind(kind) || (MODEL_SERVICES_COMMAND_KINDS as readonly string[]).includes(kind);
}

function modelInputError(message: string): never {
	throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}
function modelInputText(value: unknown, max = 512): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}
/** Called only by the executing Runtime model service. */
export function validateModelAvailableOperation(
	operation: ModelAvailableOperation | Extract<ModelServicesOperation, { kind: "models.available.refresh" }>,
): void {
	if (!modelInputText(operation?.sessionId))
		modelInputError(runtimeText("需要指定模型所属会话", "A model session is required"));
	if (operation.kind === "models.available.refresh") return;
	if (operation.kind === "models.available.release") {
		if (!modelInputText(operation.snapshotId, 256)) modelInputError("A model snapshot is required");
		return;
	}
	if (operation.kind !== "models.available.read") modelInputError("Unknown model snapshot operation");
	if (operation.cursor !== undefined && !modelInputText(operation.cursor, 256))
		modelInputError("Invalid model snapshot cursor");
	if (
		operation.limit !== undefined &&
		(!Number.isSafeInteger(operation.limit) || operation.limit < 1 || operation.limit > 200)
	)
		modelInputError("Model page size must be between 1 and 200");
	if (
		operation.providers !== undefined &&
		(!Array.isArray(operation.providers) ||
			operation.providers.length > 128 ||
			operation.providers.some(provider => !modelInputText(provider, 256)))
	)
		modelInputError("Invalid model provider selection");
	if (operation.cursor !== undefined && (operation.providers !== undefined || operation.limit !== undefined))
		modelInputError("Continue a model snapshot with its cursor only");
}
/** Restoring a paused provider is an explicit global operator action, never a project override. */
export function validateModelAuthUnpauseOperation(
	operation: Extract<ModelServicesOperation, { kind: "models.auth.unpause" }>,
): void {
	if (
		!modelInputText(operation?.sessionId) ||
		!modelInputText(operation.providerId, 256) ||
		operation.scope !== "global" ||
		operation.confirmed !== true
	)
		modelInputError("Restoring a paused provider requires explicit global confirmation");
}
