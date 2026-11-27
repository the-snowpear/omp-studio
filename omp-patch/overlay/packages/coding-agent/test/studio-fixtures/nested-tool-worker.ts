import { parentPort } from "node:worker_threads";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent, type AgentTool, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { SessionPublisher } from "../../src/thread/session-publisher";
import type { SessionBridgeClient } from "../../src/thread/session-mirror";
import { EventBus } from "../../src/utils/event-bus";

const port = parentPort!;
const auth = await AuthStorage.create(":memory:");
const manager = SessionManager.inMemory();
const settings = Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" });
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("tool_result", () => ({ content: [{ type: "text", text: "worker replacement" }], isError: false }));
	},
	process.cwd(),
	new EventBus(),
	runtime,
	"worker-rewrite",
);
const registry = new ModelRegistry(auth);
const runner = new ExtensionRunner([extension], runtime, process.cwd(), manager, registry, undefined, settings);
const agent = new Agent({
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: [], tools: [] },
});
const session = new AgentSession({
	agent,
	sessionManager: manager,
	modelRegistry: registry,
	settings,
	extensionRunner: runner,
});
const publisher = new SessionPublisher(session, {
	remote: {
		notify: (kind: string, ...args: unknown[]) => {
			if (kind === "event") port.postMessage({ kind, key: args[0], event: args[1] });
		},
	},
} as unknown as SessionBridgeClient);
publisher.watch(true);
const tool: AgentTool = {
	name: "nested",
	label: "Nested",
	description: "Worker test",
	approval: "read",
	parameters: Type.Object({}),
	execute: async () => {
		throw new Error("original worker failure");
	},
};
try {
	await new ExtensionToolWrapper(tool, runner).execute("child-call", {}, undefined, undefined, {
		parentToolCallId: "parent-call",
	} as AgentToolContext);
	port.postMessage({ kind: "complete" });
} finally {
	await session.dispose();
	auth.close();
	port.close();
}
