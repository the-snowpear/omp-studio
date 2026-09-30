import { randomUUID } from "node:crypto";
import { realizesPriorityServiceTier, serviceTierFamily, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import { cfgProvidersAnthropicSlowMode } from "../../session/settings";
import type { AgentSession } from "../../session/agent-session";
import type {
	QueueTakeback,
	SessionQueueItem,
	QueueImageAsset,
	SessionGuiOperation,
	SessionTierState,
} from "../session-gui-protocol";
import { StudioMediaFiles } from "./media-files";
import { SessionControlError } from "./session-control-service";

/** Live reads and identity-fenced mutations of the current Runtime session. */
export class StudioSessionGuiService {
	#recoveries = new Map<string, { sessionId: string; item: SessionQueueItem; result: QueueTakeback }>();

	constructor(
		readonly session: AgentSession,
		readonly files = process.env.OMP_STUDIO_MEDIA_ROOT
			? new StudioMediaFiles(process.env.OMP_STUDIO_MEDIA_ROOT)
			: undefined,
	) {}
	tier(): SessionTierState {
		const model = this.session.model;
		const family = model ? serviceTierFamily(model) : undefined;
		const configured = family ? (this.session.serviceTierByFamily[family] ?? "none") : "none";
		const available = {
			standard: !!model,
			slow: !!model && (model.provider === "anthropic" || (!!family && shouldSendServiceTier("flex", model))),
			priority: !!model && realizesPriorityServiceTier("priority", model),
			ultrafast: !!model && family === "openai" && shouldSendServiceTier("ultrafast", model),
		};
		const effective =
			this.session.isSlowModeEnabled() && available.slow
				? "slow"
				: configured === "ultrafast" && available.ultrafast
					? "ultrafast"
					: configured === "priority" && available.priority && this.session.isFastModeActive()
						? "priority"
						: "standard";
		return {
			selector: model ? model.provider + "/" + model.id : "",
			configured,
			effective,
			choices: (["standard", "slow", "priority", "ultrafast"] as const).map(id => ({
				id,
				available: available[id],
				...(!available[id] ? { reason: "Not supported by the current model / 当前模型不支持" } : {}),
			})),
			...(this.session.getAnthropicSlowModeLabel() ? { usageStatus: this.session.getAnthropicSlowModeLabel() } : {}),
		};
	}
	async execute(operation: SessionGuiOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("INVALID_ARGUMENT", "Session changed; refresh before retrying");
		switch (operation.kind) {
			case "session.queue.list": {
				const items = [
					...this.session.getStudioQueueSnapshot(),
					...Array.from(this.#recoveries.values())
						.filter(row => row.sessionId === operation.sessionId)
						.map(row => row.item),
				];
				return {
					sessionId: operation.sessionId,
					items: items.slice(operation.offset ?? 0, (operation.offset ?? 0) + 100),
					total: items.length,
					followUpMode: this.session.followUpMode,
					steeringMode: this.session.steeringMode,
				};
			}
			case "session.queue.ack":
			case "session.queue.remove": {
				const recovery = this.#recoveries.get(operation.id);
				if (recovery?.sessionId === operation.sessionId) {
					await this.files?.removeJob(operation.sessionId, randomUUID(), recovery.result.images);
					this.#recoveries.delete(operation.id);
					return { removed: true };
				}
				return {
					removed:
						operation.kind === "session.queue.remove" && this.session.removeStudioQueuedMessage(operation.id),
				};
			}
			case "session.queue.steer":
				return { removed: this.session.steerStudioQueuedMessage(operation.id) };
			case "session.queue.takeback": {
				const recovery = this.#recoveries.get(operation.id);
				if (recovery?.sessionId === operation.sessionId) return structuredClone(recovery.result);
				if (this.#recoveries.size >= 100)
					throw new SessionControlError("COMMAND_BLOCKED", "Restore or discard pending recovered drafts first");
				const item = this.session.getStudioQueueSnapshot().find(item => item.id === operation.id);
				const draft = this.session.getStudioQueueDraft(operation.id);
				if (!draft || !item) return { removed: false, images: [] };
				if (draft.images?.length && !this.files)
					throw new SessionControlError("COMMAND_BLOCKED", "Private attachment channel unavailable");
				const images: QueueImageAsset[] = [];
				try {
					for (const [index, image] of (draft.images ?? []).entries())
						images.push({
							...(await this.files!.outputBytes(
								{ name: `image-${index + 1}`, kind: "image", mimeType: image.mimeType },
								Buffer.from(image.data, "base64"),
								operation.sessionId,
							)),
							kind: "image",
						});
					if (
						operation.sessionId !== this.session.sessionId ||
						!this.session.removeStudioQueuedMessage(operation.id)
					) {
						await this.files?.removeJob(operation.sessionId, randomUUID(), images);
						return { removed: false, images: [] };
					}
					const result: QueueTakeback = { removed: true, recoveryId: operation.id, text: draft.text, images };
					this.#recoveries.set(operation.id, {
						sessionId: operation.sessionId,
						item: { ...item, state: "recovering" },
						result,
					});
					return structuredClone(result);
				} catch (error) {
					await this.files?.removeJob(operation.sessionId, randomUUID(), images);
					throw error;
				}
			}
			case "session.tier.get":
				return this.tier();
			case "session.tier.set": {
				const state = this.tier();
				if (
					state.selector !== operation.selector ||
					!state.choices.find(choice => choice.id === operation.tier)?.available
				)
					throw new SessionControlError("COMMAND_BLOCKED", "Model changed or service tier unavailable");
				const model = this.session.model!;
				const family = serviceTierFamily(model);
				// Native Anthropic slow mode writes a config handle: override only the session layer first.
				if (model.provider === "anthropic")
					cfgProvidersAnthropicSlowMode.override(
						this.session.settings,
						operation.tier === "slow" ? "auto" : "off",
					);
				if (family)
					this.session.setServiceTierFamily(
						family,
						operation.tier === "slow" && family !== "anthropic"
							? "flex"
							: operation.tier === "priority"
								? "priority"
								: operation.tier === "ultrafast"
									? "ultrafast"
									: undefined,
					);
				if (model.provider === "anthropic") {
					const lane = this.session.getAnthropicSlowModeLane();
					if (operation.tier === "slow") lane?.accept();
					else lane?.stop("user");
				}
				return this.tier();
			}
			case "session.skills.list":
				return {
					skills: this.session.skills.map(skill => ({
						id: skill.name,
						name: skill.name,
						description: skill.description,
						source: skill.source,
						scope:
							skill._source?.level === "user"
								? "global"
								: skill._source?.level === "project"
									? "workspace"
									: skill._source?.level === "native"
										? "builtin"
										: "runtime",
						...(skill.name.includes("/") ? { namespace: skill.name.split("/")[0] } : {}),
						conflict: /~\d+$/.test(skill.name),
					})),
					warnings: [],
				};
		}
	}
}
