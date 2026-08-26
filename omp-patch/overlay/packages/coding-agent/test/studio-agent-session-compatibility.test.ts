import { describe, expect, test } from "bun:test";
import type { CustomMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function mockStreamFn() {
	return {
		[Symbol.asyncIterator]: async function* () {
			yield { type: "done", reason: "stop" };
		},
		result: Promise.resolve({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Mock answer" }],
			stopReason: "stop" as const,
			usage: { input: 10, output: 5, totalTokens: 15 },
		}),
	};
}

describe("AgentSession v18.0.3 Studio compatibility and seam invariants", () => {
	test("prompt returns boolean true on normal dispatch and executes beforeNextUserTurn hook exactly once", async () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated();
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

			let hookCalls = 0;
			const agent = new Agent({
				getApiKey: () => "mock-key",
				initialState: { model, systemPrompt: ["System"], tools: [], messages: [] },
				streamFn: mockStreamFn as never,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			session.setBeforeNextUserTurn(async () => {
				hookCalls++;
			});

			const result = await session.prompt("hello world");
			expect(result).toBe(true);
			expect(hookCalls).toBe(1);
		} finally {
			authStorage.close();
		}
	});

	test("combines Studio prependMessages with upstream preludes in order without duplication", async () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated();
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

			const agent = new Agent({
				getApiKey: () => "mock-key",
				initialState: { model, systemPrompt: ["System"], tools: [], messages: [] },
				streamFn: mockStreamFn as never,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			const studioPrelude = {
				customType: "skill-prompt",
				content: "Studio Context Injection",
				display: true,
			} as CustomMessage;

			const result = await session.prompt("test prompt", {
				prependMessages: [studioPrelude],
			});
			expect(result).toBe(true);

			const messages = session.messages;
			const studioInjected = messages.find(
				m => "customType" in m && m.customType === "skill-prompt" && m.content === "Studio Context Injection",
			);
			expect(studioInjected).toBeDefined();
		} finally {
			authStorage.close();
		}
	});

	test("abort racing prompt setup sets dispatched to false and emits promptDropped callback", async () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated();
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

			let droppedPayload: { text: string; images?: unknown[] } | undefined;
			const agent = new Agent({
				getApiKey: () => "mock-key",
				initialState: { model, systemPrompt: ["System"], tools: [], messages: [] },
				streamFn: mockStreamFn as never,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});
			session.setPromptDropped(payload => {
				droppedPayload = payload;
			});

			const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			modelRegistry.getApiKey = async (m, sid) => {
				await session.abort({ reason: "Aborted during setup" });
				return originalGetApiKey(m, sid);
			};

			const result = await session.prompt("dropped text");
			expect(result).toBe(true);
			expect(droppedPayload?.text).toBe("dropped text");
		} finally {
			authStorage.close();
		}
	});
});
