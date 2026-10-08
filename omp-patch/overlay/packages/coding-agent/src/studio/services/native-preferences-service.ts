import type { AnySetting } from "../../config/registry";
import {
	cfgAdvisorEnabled,
	cfgAdvisorReviewMode,
	cfgAdvisorReviewInterval,
	cfgAdvisorSyncBacklog,
	cfgAdvisorImmuneTurns,
	cfgAdvisorMaxNotesPerUpdate,
	cfgAdvisorEvictStaleResults,
} from "../../advisor/settings";
import { cfgTitleIcons, cfgTitleGenerator, cfgTitleRefreshOnReplan } from "../../utils/title-settings";
import { cfgTelemetryOtlpExportEnabled } from "../../telemetry-settings";
import type { AgentSession } from "../../session/agent-session";
import {
	NATIVE_PREFERENCE_KEYS,
	type NativePreference,
	type NativePreferenceKey,
	type NativePreferenceOperation,
	type NativePreferenceValue,
} from "../native-preferences-protocol";
import { SessionControlError } from "./session-control-service";
const HANDLES: Record<NativePreferenceKey, AnySetting> = {
	"advisor.enabled": cfgAdvisorEnabled,
	"advisor.reviewMode": cfgAdvisorReviewMode,
	"advisor.reviewInterval": cfgAdvisorReviewInterval,
	"advisor.syncBacklog": cfgAdvisorSyncBacklog,
	"advisor.immuneTurns": cfgAdvisorImmuneTurns,
	"advisor.maxNotesPerUpdate": cfgAdvisorMaxNotesPerUpdate,
	"advisor.evictStaleResults": cfgAdvisorEvictStaleResults,
	"title.icons": cfgTitleIcons,
	"title.generator": cfgTitleGenerator,
	"title.refreshOnReplan": cfgTitleRefreshOnReplan,
	"telemetry.otlpExportEnabled": cfgTelemetryOtlpExportEnabled,
};
function scalar(value: unknown): NativePreferenceValue {
	if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
	throw new Error("Unsupported preference value");
}
export class StudioNativePreferencesService {
	readonly #otlpAtLaunch: boolean;
	constructor(readonly session: AgentSession) {
		this.#otlpAtLaunch = cfgTelemetryOtlpExportEnabled.get(session.settings);
	}
	#row(key: NativePreferenceKey): NativePreference {
		const setting = HANDLES[key],
			definition = setting.definition;
		const value = scalar(setting.get(this.session.settings));
		const effective =
			key === "telemetry.otlpExportEnabled"
				? this.#otlpAtLaunch
				: key === "advisor.enabled" && typeof this.session.isAdvisorEnabled === "function"
					? this.session.isAdvisorEnabled()
					: value;
		return {
			key,
			group: key.startsWith("advisor.") ? "advisor" : key.startsWith("title.") ? "titles" : "diagnostics",
			label: definition.ui?.label ?? key,
			description: definition.ui?.description ?? "",
			value,
			effective,
			source: this.session.settings.getProvenance(setting),
			type: definition.type === "boolean" ? "boolean" : definition.type === "number" ? "number" : "enum",
			...(setting.enumValues ? { choices: setting.enumValues.map(scalar) } : {}),
			restartRequired: key === "telemetry.otlpExportEnabled" && value !== effective,
		};
	}
	async execute(operation: NativePreferenceOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Preference session changed");
		if (operation.kind === "preferences.native.get")
			return { preferences: NATIVE_PREFERENCE_KEYS.map(key => this.#row(key)) };
		const setting = HANDLES[operation.key];
		if (operation.kind === "preferences.native.clearOverride") {
			setting.clearOverride(this.session.settings);
			return this.#row(operation.key);
		}
		setting.assertWritable(operation.value);
		if (operation.key === "telemetry.otlpExportEnabled" && operation.scope !== "global")
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"OTLP changes must be saved and take effect on the next launch",
			);
		if (operation.scope === "session") setting.override(this.session.settings, operation.value);
		else {
			setting.set(this.session.settings, operation.value);
			await this.session.settings.flush();
		}
		return this.#row(operation.key);
	}
}
