import { expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { projectRuntimeModel } from "../src/studio/services/workbench-service";
import { validateWorkbenchResult } from "../src/studio/workbench-protocol";
test("model metadata retains advertised tiers, explicit cache overrides and safe transport compatibility", () => {
	const model = {
		...getBundledModel("anthropic", "claude-sonnet-4-5")!,
		serviceTiers: ["priority", "ultrafast"],
		promptCache: { short: 300, long: 3600 },
		promptCacheConfig: {},
		preferWebsockets: true,
		useResponsesLite: true,
		toolMode: "code_mode_only" as const,
		headers: { Authorization: "private-secret" },
	};
	const unknownLimits = projectRuntimeModel({ ...model, contextWindow: null, maxTokens: null }, true);
	expect("contextWindow" in unknownLimits).toBe(false);
	expect("maxTokens" in unknownLimits).toBe(false);
	const legacy = projectRuntimeModel(model);
	expect("serviceTiers" in legacy).toBe(false);
	expect("compatibility" in legacy).toBe(false);
	const result = projectRuntimeModel(model, true);
	expect(result).toMatchObject({
		kind: "chat",
		serviceTiers: ["priority", "ultrafast"],
		promptCache: { short: 300, long: 3600 },
		promptCacheConfig: {},
		compatibility: { preferWebsockets: true, useResponsesLite: true, toolMode: "code_mode_only" },
	});
	validateWorkbenchResult("runtime.models.describe", { model: result });
	expect(JSON.stringify(result)).not.toContain("private-secret");
	expect("baseUrl" in result).toBe(false);
});
