import { resolveSessionModelSelector } from "../../config/model-resolver";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import type { SessionRestoreOperation, SessionRestoreInspection } from "../session-restore-protocol";
import { SessionControlError } from "./session-control-service";
export class StudioSessionRestoreService {
	constructor(readonly session: AgentSession) {}
	async execute(operation: SessionRestoreOperation): Promise<SessionRestoreInspection> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Session changed before model inspection");
		const manager = this.session.sessionManager;
		const candidates = await SessionManager.list(manager.getCwd(), manager.getSessionDir());
		const target = candidates.find(row => row.id === operation.targetSessionId);
		if (!target)
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"The target session is not in the current workspace session catalog",
			);
		const saved = await SessionManager.peekRestoreModels(target.path);
		if (saved.sessionId !== operation.targetSessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The session identity changed during model inspection");
		const registry = this.session.modelRegistry;
		await registry.awaitInitialBackgroundRefresh();
		const restored = saved.selectors.map(selector => resolveSessionModelSelector(registry, selector)).find(Boolean);
		const models = registry.getAvailable();
		return {
			targetSessionId: saved.sessionId,
			savedModels: saved.selectors.slice(0, 16),
			status: !saved.selectors.length ? "unconfigured" : restored ? "available" : "missing-model",
			...(restored ? { resolvedModel: restored.model.provider + "/" + restored.model.id } : {}),
			...(saved.thinking ? { thinking: saved.thinking } : {}),
			alternatives: models
				.slice(0, 500)
				.map(model => ({ model: model.provider + "/" + model.id, label: model.name || model.id })),
			truncated: models.length > 500,
		};
	}
}
