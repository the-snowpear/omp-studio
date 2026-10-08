import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { cfgProvidersCacheWarming } from "../src/session/settings";
import { applyStudioDefaults } from "../src/studio/settings-defaults";

test("Studio disables unconfigured warming without changing CLI or blocking later explicit choices", () => {
	const cli = Settings.isolated();
	const studio = Settings.isolated();
	applyStudioDefaults(studio);
	expect(cfgProvidersCacheWarming.get(studio)).toBe("off");
	expect(cfgProvidersCacheWarming.get(cli)).toBe("idle");
	cfgProvidersCacheWarming.set(studio, "streaming");
	expect(cfgProvidersCacheWarming.get(studio)).toBe("streaming");
	applyStudioDefaults(studio);
	expect(cfgProvidersCacheWarming.get(studio)).toBe("streaming");
});

test("explicit warming config survives Studio startup and repeated session initialization", () => {
	const settings = Settings.isolated({ "providers.cacheWarming": "idle" });
	applyStudioDefaults(settings);
	applyStudioDefaults(settings);
	expect(cfgProvidersCacheWarming.get(settings)).toBe("idle");
});
