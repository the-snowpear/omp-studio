import type { Model } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_PREWALK_TARGET,
	expandRoleAlias,
	getModelMatchPreferences,
	resolveCliModel,
} from "../../config/model-resolver";
import type { AgentSession } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../thinking";

export class StudioFastPrewalkError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "COMMAND_BLOCKED",
		message: string,
	) {
		super(message);
		this.name = "StudioFastPrewalkError";
	}
}

export interface StudioFastState {
	enabled: boolean;
	active: boolean;
}

export interface StudioPrewalkState {
	status: "armed";
	target: string;
}

export interface ResolvedPrewalkTarget {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	selector: string;
}

export type ResolvePrewalkTarget = (selector: string) => ResolvedPrewalkTarget;

/** Presentation-neutral `/fast` and `/prewalk` adapters for the Studio Bridge. */
export class StudioFastPrewalkService {
	constructor(
		private readonly session: AgentSession,
		private readonly resolveTarget: ResolvePrewalkTarget = selector => resolvePrewalkTarget(session, selector),
	) {}

	setFast(enabled: boolean): StudioFastState {
		if (!this.session.setFastMode(enabled)) {
			throw new StudioFastPrewalkError(
				"COMMAND_BLOCKED",
				"The current model has no service-tier control for fast mode",
			);
		}
		return {
			enabled: this.session.isFastModeEnabled(),
			active: this.session.isFastModeActive(),
		};
	}

	arm(target?: string): StudioPrewalkState {
		const resolved = this.resolveTarget(normalizeSelector(target));
		const current = this.session.getPrewalkState();
		if (current) {
			const sameTarget =
				current.target.provider === resolved.model.provider &&
				current.target.id === resolved.model.id &&
				current.thinkingLevel === resolved.thinkingLevel;
			if (sameTarget) {
				return { status: "armed", target: resolved.selector };
			}
			this.session.disarmPrewalk();
		}
		const armed = this.session.armPrewalk(resolved.model, resolved.thinkingLevel);
		if (!armed) {
			throw new StudioFastPrewalkError(
				"COMMAND_BLOCKED",
				"Prewalk target already matches the active model and thinking level",
			);
		}
		return { status: "armed", target: resolved.selector };
	}

	disarm(): { disarmed: boolean } {
		return { disarmed: this.session.disarmPrewalk() };
	}
}

export function resolvePrewalkTarget(session: AgentSession, selector: string): ResolvedPrewalkTarget {
	const rolePattern = expandRoleAlias(selector, session.settings);
	const resolved = resolveCliModel({
		cliModel: rolePattern,
		modelRegistry: session.modelRegistry,
		preferences: getModelMatchPreferences(session.settings),
	});
	if (resolved.error || !resolved.model) {
		throw new StudioFastPrewalkError("INVALID_ARGUMENT", resolved.error ?? `Model "${selector}" not found`);
	}
	if (!session.modelRegistry.hasConfiguredAuth(resolved.model)) {
		throw new StudioFastPrewalkError(
			"COMMAND_BLOCKED",
			`No API key for ${resolved.model.provider}/${resolved.model.id}`,
		);
	}
	return { model: resolved.model, thinkingLevel: resolved.thinkingLevel, selector };
}

function normalizeSelector(target: string | undefined): string {
	const trimmed = target?.trim();
	return trimmed ? trimmed : DEFAULT_PREWALK_TARGET;
}
