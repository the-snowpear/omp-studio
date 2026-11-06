import type { Model } from "@oh-my-pi/pi-ai";
import type { ScopeLike } from "../../config/registry";
import type { CompactionSettings } from "../../session/context-settings";
import { resolveModelCompactionSettings } from "../../session/model-compaction-threshold";
import type { SessionManager } from "../../session/session-manager";
import {
	SESSION_COMPACTION_ENTRY,
	readSessionCompactionThreshold,
	type SessionCompactionThreshold,
} from "../session-compaction-protocol";

export function sessionCompactionThreshold(manager: SessionManager): SessionCompactionThreshold | null {
	const sessionId = manager.getSessionId();
	const entry = manager.findLastCustomEntry(SESSION_COMPACTION_ENTRY, candidate => {
		const data = candidate.data as { sessionId?: string; input?: string } | undefined;
		return data?.sessionId === sessionId && typeof data.input === "string";
	});
	return entry ? readSessionCompactionThreshold(sessionId, [entry]) : null;
}

/** The conversation wins over model rules, without changing Settings or child/advisor policies. */
export function resolveSessionCompactionSettings(
	settings: ScopeLike,
	model: Model | null | undefined,
	manager: SessionManager,
): CompactionSettings {
	const configured = resolveModelCompactionSettings(settings, model);
	const threshold = sessionCompactionThreshold(manager);
	if (!threshold) return configured;
	const { baseWindowTokens: _base, ...base } = configured;
	return {
		...base,
		thresholdPercent: threshold.kind === "percent" ? threshold.value : -1,
		// Resolve percentages against the current model on every check, including decimal
		// percentages outside the native settings picker's 1–99 preset range.
		thresholdTokens:
			threshold.kind === "tokens"
				? threshold.value
				: model?.contextWindow
					? Math.max(1, Math.floor((model.contextWindow * threshold.value) / 100))
					: -1,
	};
}
