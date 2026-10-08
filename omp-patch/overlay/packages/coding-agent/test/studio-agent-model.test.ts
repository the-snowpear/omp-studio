import { expect, test, spyOn } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AgentRegistry, type AgentRef } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { StudioAgentModelService } from "../src/studio/services/agent-model-service";
import { ownedStudioSessions } from "../src/studio/services/owned-sessions";
import { validateAgentModelResult } from "../src/studio/agent-model-protocol";
test("agent model details use native routing and only inspect descendants of the current session", async () => {
	const manager = SessionManager.inMemory();
	manager.appendSessionInit({
		systemPrompt: [],
		task: "fixture",
		tools: [],
		retryFallback: { primary: "primary/model:high", chain: ["backup/model:medium"] },
	});
	const main = { sessionId: "parent" } as AgentSession;
	const child = {
		sessionId: "child",
		sessionManager: manager,
		model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
		servingModel: { selector: "backup/model:medium", modelIdentity: "backup/model", isFallback: true },
		configuredThinkingLevel: () => "auto",
		thinkingLevel: "medium",
	} as unknown as AgentSession;
	const refs = [
		{ id: "Main", session: main },
		{ id: "Child", parentId: "Main", session: child },
		{ id: "Other", session: { sessionId: "other" } },
		{ id: "Foreign", parentId: "Other", session: child },
	] as AgentRef[];
	const registry = AgentRegistry.global();
	const list = spyOn(registry, "list").mockReturnValue(refs);
	const get = spyOn(registry, "get").mockImplementation(id => refs.find(ref => ref.id === id));
	try {
		const service = new StudioAgentModelService(main);
		const result = await service.execute({ kind: "agent.model.inspect", sessionId: "parent", agentId: "Child" });
		expect(result).toMatchObject({
			source: "live",
			configuredThinking: "auto",
			effectiveThinking: "medium",
			servingModel: "backup/model",
			usingFallback: true,
			candidates: ["primary/model:high", "backup/model:medium"],
		});
		validateAgentModelResult("agent.model.inspect", result);
		expect(ownedStudioSessions(main).map(session => session.sessionId)).toEqual(["parent", "child"]);
		await expect(
			service.execute({ kind: "agent.model.inspect", sessionId: "parent", agentId: "Foreign" }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		await expect(
			service.execute({ kind: "agent.model.inspect", sessionId: "other", agentId: "Child" }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		get.mockRestore();
		list.mockRestore();
		await manager.close();
	}
});

test("parked agents expose saved configuration and reject results after registry ownership changes", async () => {
	const main = { sessionId: "parent" } as AgentSession;
	const parked = { id: "Parked", parentId: "Main", sessionFile: "/saved.jsonl" } as AgentRef;
	const refs = [{ id: "Main", session: main } as AgentRef, parked];
	const registry = AgentRegistry.global();
	const list = spyOn(registry, "list").mockReturnValue(refs);
	const get = spyOn(registry, "get").mockImplementation(id => refs.find(ref => ref.id === id));
	const peek = spyOn(SessionManager, "peekRestoreModels").mockResolvedValue({
		sessionId: "saved",
		selectors: ["saved/model"],
		thinking: "high",
	});
	const init = spyOn(SessionManager, "peekSessionInit").mockResolvedValue(null);
	try {
		const service = new StudioAgentModelService(main);
		expect(await service.execute({ kind: "agent.model.inspect", sessionId: "parent", agentId: "Parked" })).toEqual({
			agentId: "Parked",
			source: "saved",
			selectedModel: "saved/model",
			configuredThinking: "high",
		});
		const pending = Promise.withResolvers<{ sessionId: string; selectors: string[]; thinking?: string }>();
		peek.mockImplementationOnce(() => pending.promise);
		const reading = service.execute({ kind: "agent.model.inspect", sessionId: "parent", agentId: "Parked" });
		parked.parentId = "Unrelated";
		pending.resolve({ sessionId: "saved", selectors: ["foreign/model"] });
		await expect(reading).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		parked.parentId = "Parked";
		await expect(
			service.execute({ kind: "agent.model.inspect", sessionId: "parent", agentId: "Parked" }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		init.mockRestore();
		peek.mockRestore();
		get.mockRestore();
		list.mockRestore();
	}
});
