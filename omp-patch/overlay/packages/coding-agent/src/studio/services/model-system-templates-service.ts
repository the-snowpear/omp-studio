import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, isEnoent, isRecord, truncate } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { cfgSystemPromptTemplates } from "../../session/settings";
import { expandTilde } from "../../tools/path-utils";
import { writeFileAtomically } from "../../utils/atomic-file";
import type {
	ModelServicesOperation,
	ModelSystemTemplateBinding,
	ModelSystemTemplateFile,
	ModelSystemTemplateInspection,
	ModelSystemTemplateWriteResult,
	ModelSystemTemplatesList,
} from "../model-services-protocol";
import { SessionControlError } from "./session-control-service";

const TEXT_LIMIT = 128 * 1024;
// Two JSON-escaped previews together remain below the Bridge's 1 MiB control-frame budget.
const PREVIEW_LIMIT = 64 * 1024;
const version = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** File/config ownership and rendering remain native. No slash-template expansion or YAML model override. */
export class StudioModelSystemTemplatesService {
	constructor(readonly session: AgentSession) {}

	#check(sessionId: string): void {
		if (sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The template session changed; reload the editor");
	}

	list(sessionId: string): ModelSystemTemplatesList {
		this.#check(sessionId);
		const state = this.session.settings.mirrorState();
		const layers = [
			["global", state.global],
			["project", state.project],
			["overlay", state.configOverlay],
			["runtime", state.overrides],
		] as const;
		const effective = cfgSystemPromptTemplates.get(this.session.settings);
		const winners = new Map<string, ModelSystemTemplateBinding>();
		const globals: ModelSystemTemplateBinding[] = [];
		for (const [source, layer] of layers) {
			const templates = layer.systemPromptTemplates;
			if (!isRecord(templates)) continue;
			for (const [pattern, file] of Object.entries(templates)) {
				if (typeof file !== "string") continue;
				const binding: ModelSystemTemplateBinding = {
					pattern,
					file,
					source,
					editable: source === "global",
					effective: false,
				};
				if (source === "global") globals.push(binding);
				winners.set(pattern, binding);
			}
		}
		const bindings = [...globals];
		for (const [pattern, file] of Object.entries(effective)) {
			const winner = winners.get(pattern);
			if (winner) {
				winner.effective = true;
				if (winner.source !== "global") bindings.push(winner);
			} else bindings.push({ pattern, file, source: "runtime", editable: false, effective: true });
		}
		return { sessionId, version: version(JSON.stringify(bindings)), bindings };
	}

	async file(sessionId: string, pattern: string): Promise<ModelSystemTemplateFile> {
		this.#check(sessionId);
		const binding = this.list(sessionId).bindings.find(row => row.pattern === pattern && row.effective);
		if (!binding) throw new SessionControlError("INVALID_ARGUMENT", "Select a configured system template");
		const file = expandTilde(binding.file);
		try {
			const stat = await fs.stat(file);
			if (!stat.isFile() || stat.size > TEXT_LIMIT)
				throw new SessionControlError(
					"INVALID_ARGUMENT",
					"The template editor supports regular UTF-8 files up to 128 KiB",
				);
			const bytes = new Uint8Array(
				await Bun.file(file)
					.slice(0, TEXT_LIMIT + 1)
					.arrayBuffer(),
			);
			if (bytes.length > TEXT_LIMIT)
				throw new SessionControlError("INVALID_ARGUMENT", "The system template exceeds the 128 KiB editor limit");
			if (bytes.includes(0)) throw new SessionControlError("INVALID_ARGUMENT", "The selected template is not text");
			const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			this.#check(sessionId);
			return { pattern, file, version: version(file + "\0" + content), content, exists: true, editable: true };
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { pattern, file, version: version(file + "\0missing"), content: "", exists: false, editable: true };
		}
	}

	async inspect(sessionId: string, selector: string): Promise<ModelSystemTemplateInspection> {
		this.#check(sessionId);
		const model = this.session.modelRegistry
			.getAvailable("all")
			.find(row => `${row.provider}/${row.id}` === selector);
		if (!model) throw new SessionControlError("INVALID_ARGUMENT", "The selected model is unavailable");
		const built = await this.session.previewSystemPrompt(model);
		this.#check(sessionId);
		const preview = built.systemPrompt.join("\n\n");
		const liveContent = this.session.systemPrompt.join("\n\n");
		const isLive = this.session.model?.provider === model.provider && this.session.model.id === model.id;
		return {
			selector,
			selection: built.selection ?? { source: "explicit-text" },
			preview: truncate(preview, PREVIEW_LIMIT),
			...(isLive
				? {
						live: {
							...(this.session.systemPromptSelection ? { selection: this.session.systemPromptSelection } : {}),
							content: truncate(liveContent, PREVIEW_LIMIT),
							matchesPreview: liveContent === preview,
						},
					}
				: {}),
			truncated: preview.length > PREVIEW_LIMIT || (isLive && liveContent.length > PREVIEW_LIMIT),
		};
	}

	async execute(
		operation: Extract<ModelServicesOperation, { kind: `models.systemTemplates.${string}` }>,
	): Promise<
		| ModelSystemTemplatesList
		| ModelSystemTemplateFile
		| ModelSystemTemplateInspection
		| ModelSystemTemplateWriteResult
	> {
		this.#check(operation.sessionId);
		if (operation.kind === "models.systemTemplates.list") return this.list(operation.sessionId);
		if (operation.kind === "models.systemTemplates.inspect")
			return this.inspect(operation.sessionId, operation.selector);
		if (operation.kind === "models.systemTemplates.file.read")
			return this.file(operation.sessionId, operation.pattern);
		if (operation.kind === "models.systemTemplates.binding.set") {
			const current = this.list(operation.sessionId);
			if (operation.version !== current.version)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"System template associations changed; reload before saving",
				);
			const old = operation.previousPattern ?? operation.pattern;
			if (operation.file !== null) cfgSystemPromptTemplates.assertWritable({ [operation.pattern]: operation.file });
			if (old !== operation.pattern || operation.file === null)
				cfgSystemPromptTemplates.setEntry(this.session.settings, old, undefined);
			if (operation.file !== null)
				cfgSystemPromptTemplates.setEntry(this.session.settings, operation.pattern, operation.file);
			await this.session.settings.flush();
			await this.session.refreshBaseSystemPrompt();
			return this.list(operation.sessionId);
		}
		const current = await this.file(operation.sessionId, operation.pattern);
		if (current.version !== operation.version)
			throw new SessionControlError("COMMAND_BLOCKED", "The system template changed; reopen it before saving");
		if (
			typeof operation.content !== "string" ||
			Buffer.byteLength(operation.content) > TEXT_LIMIT ||
			operation.content.includes("\0")
		)
			throw new SessionControlError("INVALID_ARGUMENT", "System template text exceeds editor limits");
		await fs.mkdir(path.dirname(current.file), { recursive: true });
		const target = current.exists ? await fs.realpath(current.file) : current.file;
		const lock = await acquireFileLock(target);
		try {
			const fresh = await this.file(operation.sessionId, operation.pattern);
			if (fresh.version !== operation.version || fresh.file !== current.file)
				throw new SessionControlError("COMMAND_BLOCKED", "The system template changed; reopen it before saving");
			const mode = current.exists ? (await fs.stat(target)).mode & 0o777 : 0o600;
			await writeFileAtomically(target, operation.content, mode);
		} finally {
			lock.release();
		}
		await this.session.refreshBaseSystemPrompt();
		const saved = await this.file(operation.sessionId, operation.pattern);
		return { pattern: saved.pattern, file: saved.file, version: saved.version, saved: true };
	}
}
