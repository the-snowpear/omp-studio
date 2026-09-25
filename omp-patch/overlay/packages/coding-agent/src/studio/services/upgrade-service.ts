import * as path from "node:path";
import { directoryExists } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { createForeignSessionStore, persistForeignSession } from "../../session/foreign-session-import";
import type { ForeignSessionInfo } from "../../session/foreign-session-store";
import type { UpgradeOperation, ForeignSessionSummary } from "../runtime-upgrade-protocol";
import type { StudioBtwService } from "./btw-service";
import { SessionControlError } from "./session-control-service";

/** Native Runtime facilities shared with GUI; no CLI/TUI automation. */
export class StudioUpgradeService {
	constructor(
		readonly session: AgentSession,
		readonly btw: StudioBtwService,
	) {}
	async execute(operation: UpgradeOperation): Promise<unknown> {
		switch (operation.kind) {
			case "btw.history.list":
				return this.btw.historyList();
			case "btw.history.read":
				return this.btw.historyRead(operation.topicId);
			case "btw.followUp":
				return this.btw.followUp(operation.topicId, operation.question);
			case "session.models.mentions": {
				const scoped = this.session.scopedModels.map(row => row.model);
				const models = scoped.length ? scoped : this.session.modelRegistry.getAvailable();
				return {
					sessionId: this.session.sessionId,
					mentions: this.session.modelMentions.map(mention => ({ ...mention })),
					available: models.map(model => ({
						selector: model.provider + "/" + model.id,
						name: model.name,
						image: model.input.includes("image"),
					})),
					activeModelImage: this.session.model?.input.includes("image") === true,
				};
			}
			case "runtime.auth.get":
			case "runtime.auth.set":
			case "runtime.auth.remove": {
				const auth = this.session.modelRegistry.authStorage;
				try {
					if (operation.kind === "runtime.auth.set")
						await auth.credentials.set(operation.provider, { type: "api_key", key: operation.apiKey });
					if (operation.kind === "runtime.auth.remove") await auth.credentials.remove(operation.provider);
					const last =
						operation.provider === "typesafe"
							? [...this.session.sessionManager.getBranch()]
									.reverse()
									.find(
										entry =>
											entry.type === "model_usage" &&
											entry.purpose === "auto-thinking" &&
											entry.stopReason !== "error" &&
											entry.stopReason !== "aborted",
									)
							: undefined;
					return {
						provider: operation.provider,
						configured: auth.keys.source(operation.provider) !== undefined,
						...(last?.type === "model_usage"
							? { lastJudgment: { purpose: last.purpose, provider: last.provider, model: last.model } }
							: {}),
					};
				} catch {
					throw new SessionControlError("COMMAND_BLOCKED", "Credential storage is unavailable");
				}
			}
			case "session.import.list": {
				const store = createForeignSessionStore(operation.source);
				const sessions = (await store.list())
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())
					.slice(0, 200);
				return { sessions: await Promise.all(sessions.map(session => this.#summary(session))) };
			}
			case "session.import.preview":
			case "session.import.execute": {
				const store = createForeignSessionStore(operation.source);
				const matches = (await store.list()).filter(session => session.id === operation.sourceId);
				if (matches.length !== 1)
					throw new SessionControlError(
						"INVALID_ARGUMENT",
						"Source session is missing or ambiguous; refresh the list",
					);
				const info = matches[0]!;
				if (operation.kind === "session.import.preview") {
					const converted = await store.load(info);
					const text = converted
						.getBranch()
						.flatMap(entry => {
							if (entry.type !== "message") return [];
							const message = entry.message;
							if (message.role !== "user" && message.role !== "assistant") return [];
							const body =
								typeof message.content === "string"
									? message.content
									: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
							return [message.role + ": " + body];
						})
						.join("\n\n")
						.slice(0, 32768);
					return { session: await this.#summary(info), preview: text };
				}
				if (
					!(await directoryExists(info.cwd)) &&
					(!operation.fallbackCwd || !(await directoryExists(operation.fallbackCwd)))
				)
					throw new SessionControlError(
						"INVALID_ARGUMENT",
						"The source working directory is missing; select an existing workspace",
					);
				// Retry dedupe lives in the dispatcher's receipt cache (keyed by
				// requestId / idempotencyKey); each dispatch gets a fresh
				// commandId, so a per-command table here could never hit.
				const imported = await persistForeignSession(store, info, {
					...(operation.fallbackCwd ? { fallbackCwd: operation.fallbackCwd } : {}),
					suppressBreadcrumb: true,
				});
				return {
					imported: true as const,
					sessionId: imported.getSessionId(),
					cwd: imported.getCwd(),
				};
			}
		}
	}
	async #summary(info: ForeignSessionInfo): Promise<ForeignSessionSummary> {
		return {
			source: info.source,
			sourceId: info.id,
			title: (info.title ?? info.firstMessage ?? info.id).slice(0, 512),
			directoryName: path.basename(info.cwd),
			cwdExists: await directoryExists(info.cwd),
			modifiedAt: info.modified.toISOString(),
			...(info.messageCount === undefined ? {} : { messageCount: info.messageCount }),
			...(info.firstMessage === undefined ? {} : { firstMessage: info.firstMessage.slice(0, 2048) }),
		};
	}
}
