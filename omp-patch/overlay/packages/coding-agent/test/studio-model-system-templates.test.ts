import { describe, expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { cfgSystemPromptTemplates } from "../src/session/settings";
import { StudioModelSystemTemplatesService } from "../src/studio/services/model-system-templates-service";

const model = getBundledModel("openai", "gpt-4o-mini");
if (!model) throw new Error("The test requires the bundled OpenAI model");

describe("Studio bounded system-template reads", () => {
	test("combined preview and live content remain within the Bridge JSON frame budget, with honest truncation", async () => {
		const huge = "\u0001".repeat(200000);
		const service = new StudioModelSystemTemplatesService({
			sessionId: "owner",
			model,
			systemPrompt: [huge],
			modelRegistry: { getAvailable: () => [model] },
			previewSystemPrompt: async () => ({ systemPrompt: [huge], selection: { source: "bundled" } }),
		} as unknown as AgentSession);
		const result = await service.inspect("owner", "openai/gpt-4o-mini");
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
		expect(result.live?.matchesPreview).toBe(true);
	});

	test("an oversized file is not returned as a supposedly complete editable template", async () => {
		using tempDir = TempDir.createSync("@omp-studio-template-size-");
		const file = tempDir.join("system.md"),
			settings = Settings.isolated();
		await Bun.write(file, "x".repeat(128 * 1024 + 1));
		cfgSystemPromptTemplates.setEntry(settings, "gpt", file);
		const service = new StudioModelSystemTemplatesService({
			sessionId: "owner",
			settings,
		} as unknown as AgentSession);
		await expect(service.file("owner", "gpt")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	});
});
