import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Rule } from "../../capability/rule";
import {
	buildOmfgRuleForPath,
	extractGeneratedRuleJson,
	type OmfgRuleSourceLevel,
	type ParsedGeneratedRule,
	parseGeneratedRule,
	sanitizeRuleName,
	validateParsedRuleAgainstAssistantHistory,
} from "../../modes/controllers/omfg-rule";
import omfgUserPrompt from "../../prompts/system/omfg-user.md" with { type: "text" };

const DEFAULT_MAX_INPUT_LENGTH = 64 * 1024;
const DEFAULT_MAX_CANDIDATE_BYTES = 1024 * 1024;

export type StudioOmfgScope = OmfgRuleSourceLevel;

export interface StudioOmfgCandidate {
	candidateId: string;
	ruleName: string;
	fileContent: string;
	validated: boolean;
	repairedCondition: boolean;
}

export interface StudioOmfgModelPort {
	runEphemeralTurn(args: {
		promptText: string;
		dedupeReply?: boolean;
		signal?: AbortSignal;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }>;
	getMessages(): readonly AgentMessage[];
}

export interface StudioOmfgStoragePort {
	resolveRulePath(scope: StudioOmfgScope, ruleName: string): string;
	exists(filePath: string): Promise<boolean>;
	write(filePath: string, content: string): Promise<void>;
	writeAtomic?(filePath: string, content: string): Promise<void>;
}

export interface StudioOmfgLivePort {
	register(rule: Rule): boolean | Promise<boolean>;
	reload?(rule: Rule): void | Promise<void>;
}

export interface StudioOmfgInteractionPort {
	confirm(input: { commandId: string; title: string; message: string; destructive: true }): Promise<boolean>;
}

export interface StudioOmfgServiceOptions {
	idGenerator?: () => string;
	rollback?: (filePath: string) => void | Promise<void>;
	finalize?: (filePath: string) => void | Promise<void>;
	maxInputLength?: number;
	maxCandidateBytes?: number;
}

export type StudioOmfgCommitResult =
	| { committed: true; scope: StudioOmfgScope; ruleName: string }
	| { committed: false; reason: "cancelled"; scope: StudioOmfgScope; ruleName: string };

export class StudioOmfgError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "INTERACTION_STALE" | "COMMAND_BLOCKED" | "INTERNAL_ERROR",
		message: string,
		readonly partial = false,
	) {
		super(message);
		this.name = "StudioOmfgError";
	}
}

interface CandidateRecord {
	candidateId: string;
	complaint: string;
	candidate: ParsedGeneratedRule;
	validated: boolean;
	repairedCondition: boolean;
}

/** Presentation-neutral, one-candidate OMFG workflow. */
export class StudioOmfgService {
	readonly #idGenerator: () => string;
	readonly #rollback: ((filePath: string) => void | Promise<void>) | undefined;
	readonly #finalize: ((filePath: string) => void | Promise<void>) | undefined;
	readonly #maxInputLength: number;
	readonly #maxCandidateBytes: number;
	#candidate: CandidateRecord | undefined;
	#running = false;

	constructor(
		private readonly model: StudioOmfgModelPort,
		private readonly storage: StudioOmfgStoragePort,
		private readonly live: StudioOmfgLivePort,
		private readonly interaction: StudioOmfgInteractionPort,
		options: StudioOmfgServiceOptions = {},
	) {
		this.#idGenerator = options.idGenerator ?? randomUUID;
		this.#rollback = options.rollback;
		this.#finalize = options.finalize;
		this.#maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
		this.#maxCandidateBytes = options.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES;
		if (!Number.isSafeInteger(this.#maxInputLength) || this.#maxInputLength < 1) {
			throw new RangeError("OMFG input limit must be a positive integer");
		}
		if (!Number.isSafeInteger(this.#maxCandidateBytes) || this.#maxCandidateBytes < 1) {
			throw new RangeError("OMFG candidate limit must be a positive integer");
		}
	}

	async generate(complaint: string): Promise<StudioOmfgCandidate> {
		const normalized = this.#requireInput(complaint, "OMFG complaint");
		const replyText = await this.#runTurn(prompt.render(omfgUserPrompt, { complaint: normalized }));
		return this.#acceptCandidate(normalized, replyText);
	}

	async amend(candidateId: string, feedback: string): Promise<StudioOmfgCandidate> {
		const current = this.#require(candidateId);
		const normalized = this.#requireInput(feedback, "OMFG amendment feedback");
		const replyText = await this.#runTurn(
			prompt.render(omfgUserPrompt, {
				complaint: current.complaint,
				feedback: `User requested this amendment before saving:\n${normalized}`,
				previousRule: current.candidate.fileContent,
			}),
		);
		return this.#acceptCandidate(current.complaint, replyText, current.candidateId);
	}

	async commit(
		candidateId: string,
		scope: StudioOmfgScope,
		overwrite: boolean,
		commandId: string,
	): Promise<StudioOmfgCommitResult> {
		const current = this.#require(candidateId);
		if (scope !== "project" && scope !== "user") {
			throw new StudioOmfgError("INVALID_ARGUMENT", "OMFG commit scope must be project or user");
		}
		const ruleName = sanitizeRuleName(current.candidate.rule.name);
		const filePath = this.#resolvePath(scope, ruleName);
		if ((await this.#targetExists(filePath)) && !overwrite) {
			const approved = await this.#confirmOverwrite(ruleName, commandId);
			if (!approved) return { committed: false, reason: "cancelled", scope, ruleName };
		}

		await this.#write(filePath, current.candidate.fileContent);
		const rule = buildOmfgRuleForPath(ruleName, current.candidate.fileContent, filePath, scope);
		await this.#register(rule, filePath);
		try {
			await this.#reload(rule);
		} finally {
			await this.#finalizeWrite(filePath);
		}
		this.#candidate = undefined;
		return { committed: true, scope, ruleName };
	}

	#requireInput(value: string, label: string): string {
		const normalized = value.trim();
		if (normalized.length === 0) throw new StudioOmfgError("INVALID_ARGUMENT", `${label} must not be empty`);
		if (normalized.length > this.#maxInputLength) {
			throw new StudioOmfgError("INVALID_ARGUMENT", `${label} is too long`);
		}
		return normalized;
	}

	async #runTurn(promptText: string): Promise<string> {
		if (this.#running) throw new StudioOmfgError("COMMAND_BLOCKED", "An OMFG generation is already running");
		this.#running = true;
		try {
			return (await this.model.runEphemeralTurn({ promptText, dedupeReply: false })).replyText;
		} catch {
			throw new StudioOmfgError("INTERNAL_ERROR", "OMFG generation failed");
		} finally {
			this.#running = false;
		}
	}

	#acceptCandidate(complaint: string, replyText: string, candidateId = this.#idGenerator()): StudioOmfgCandidate {
		const parsed = parseGeneratedRule(replyText);
		if ("error" in parsed) {
			const message = extractGeneratedRuleJson(replyText)
				? "The model returned an invalid rule; the current candidate was kept"
				: "The model did not return a rule; the current candidate was kept";
			throw new StudioOmfgError("COMMAND_BLOCKED", message);
		}
		if (Buffer.byteLength(parsed.fileContent, "utf8") > this.#maxCandidateBytes) {
			throw new StudioOmfgError(
				"COMMAND_BLOCKED",
				"The generated rule is too large; the current candidate was kept",
			);
		}

		let validation: ReturnType<typeof validateParsedRuleAgainstAssistantHistory>;
		try {
			validation = validateParsedRuleAgainstAssistantHistory(parsed, this.model.getMessages());
		} catch {
			throw new StudioOmfgError("INTERNAL_ERROR", "OMFG rule validation failed");
		}
		const record: CandidateRecord = {
			candidateId,
			complaint,
			candidate: validation.candidate,
			validated: validation.validation.matched,
			repairedCondition: validation.repairedCondition,
		};
		this.#candidate = record;
		return this.#dto(record);
	}

	#require(candidateId: string): CandidateRecord {
		if (this.#candidate === undefined || this.#candidate.candidateId !== candidateId) {
			throw new StudioOmfgError("INTERACTION_STALE", "OMFG candidate is stale or unknown");
		}
		return this.#candidate;
	}

	#resolvePath(scope: StudioOmfgScope, ruleName: string): string {
		try {
			return this.storage.resolveRulePath(scope, ruleName);
		} catch {
			throw new StudioOmfgError("INTERNAL_ERROR", "The rule target could not be resolved");
		}
	}

	async #targetExists(filePath: string): Promise<boolean> {
		try {
			return await this.storage.exists(filePath);
		} catch {
			throw new StudioOmfgError("INTERNAL_ERROR", "The rule target could not be checked");
		}
	}

	async #confirmOverwrite(ruleName: string, commandId: string): Promise<boolean> {
		try {
			return await this.interaction.confirm({
				commandId,
				title: "Overwrite TTSR rule?",
				message: `${ruleName} already exists. Overwrite it?`,
				destructive: true,
			});
		} catch {
			throw new StudioOmfgError("INTERNAL_ERROR", "OMFG overwrite confirmation failed");
		}
	}

	async #write(filePath: string, content: string): Promise<void> {
		try {
			if (this.storage.writeAtomic) await this.storage.writeAtomic(filePath, content);
			else await this.storage.write(filePath, content);
		} catch {
			throw new StudioOmfgError("INTERNAL_ERROR", "The rule could not be written");
		}
	}

	async #register(rule: Rule, filePath: string): Promise<void> {
		let registered = false;
		try {
			registered = await this.live.register(rule);
		} catch {
			registered = false;
		}
		if (registered) return;
		if (this.#rollback) {
			try {
				await this.#rollback(filePath);
			} catch {}
		}
		throw new StudioOmfgError(
			"INTERNAL_ERROR",
			"The rule was written but could not be registered for live use",
			true,
		);
	}

	async #reload(rule: Rule): Promise<void> {
		if (!this.live.reload) return;
		try {
			await this.live.reload(rule);
		} catch {
			throw new StudioOmfgError("INTERNAL_ERROR", "The rule was committed but live reload failed", true);
		}
	}

	async #finalizeWrite(filePath: string): Promise<void> {
		if (!this.#finalize) return;
		try {
			await this.#finalize(filePath);
		} catch {}
	}

	#dto(record: CandidateRecord): StudioOmfgCandidate {
		return structuredClone({
			candidateId: record.candidateId,
			ruleName: sanitizeRuleName(record.candidate.rule.name),
			fileContent: record.candidate.fileContent,
			validated: record.validated,
			repairedCondition: record.repairedCondition,
		});
	}
}
