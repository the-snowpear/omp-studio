import type { Settings } from "../config/settings";
import { cfgProvidersCacheWarming } from "../session/settings";
import { cfgTaskAgentIdleTtlMs } from "../task/settings";

/** Studio defaults are soft pins: explicit config and later saves always win. */
export function applyStudioDefaults(settings: Settings): void {
	settings.pinDefaultValue(cfgProvidersCacheWarming, "off");
	settings.pinDefaultValue(cfgTaskAgentIdleTtlMs, 300_000);
}
