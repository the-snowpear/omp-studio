import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { cfgTaskAgentAccountPools } from "../src/task/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioFeatureSettingsService } from "../src/studio/services/feature-settings-service";
import type { AgentAccountPoolState } from "../src/studio/feature-settings-protocol";

test("saving one agent preserves other global entries without persisting session policy", async () => {
	const settings = Settings.isolated({
		"task.agentAccountPools": { scout: { anthropic: ["email:session@example.test"] }, reviewer: { anthropic: [] } },
	});
	cfgTaskAgentAccountPools.setEntry(settings, "task", { anthropic: ["email:global@example.test"] });
	const service = new StudioFeatureSettingsService({ sessionId: "main", settings } as AgentSession);
	const result = (await service.execute({
		kind: "accounts.pool.set",
		sessionId: "main",
		agent: "reviewer",
		pools: { anthropic: ["email:review@example.test"] },
	})) as AgentAccountPoolState;
	expect(result.global).toEqual({
		task: { anthropic: ["email:global@example.test"] },
		reviewer: { anthropic: ["email:review@example.test"] },
	});
	expect(result.effective.reviewer).toEqual({ anthropic: [] });
	expect(result.effective.scout).toEqual({ anthropic: ["email:session@example.test"] });
	expect(result.global.scout).toBeUndefined();
	const reset = (await service.execute({
		kind: "accounts.pool.set",
		sessionId: "main",
		agent: "reviewer",
		pools: null,
	})) as AgentAccountPoolState;
	expect(reset.global.reviewer).toBeUndefined();
	expect(reset.global.task).toEqual(result.global.task);
	expect(reset.effective.reviewer).toEqual({ anthropic: [] });
});

test("an empty provider pool is persisted as a block, while removing it restores default selection", async () => {
	const settings = Settings.isolated();
	const service = new StudioFeatureSettingsService({ sessionId: "main", settings } as AgentSession);
	await service.execute({
		kind: "accounts.pool.set",
		sessionId: "main",
		agent: "reviewer",
		pools: { anthropic: [], "openai-codex": ["account:work"] },
	});
	expect(cfgTaskAgentAccountPools.get(settings).reviewer?.anthropic).toEqual([]);
	await service.execute({
		kind: "accounts.pool.set",
		sessionId: "main",
		agent: "reviewer",
		pools: { "openai-codex": ["account:work"] },
	});
	expect(cfgTaskAgentAccountPools.get(settings).reviewer?.anthropic).toBeUndefined();
	expect(cfgTaskAgentAccountPools.get(settings).reviewer?.["openai-codex"]).toEqual(["account:work"]);
});
