import { afterEach, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import type { AgentSession } from "../src/session/agent-session";
import type { TodoPhase } from "../src/tools/details/todo";
import { StudioTodoBackendService } from "../src/studio/services/todo-backend-service";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sessions: AgentSession[] = [];
const dirs: TempDir[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) {
		await session.dispose();
		session.modelRegistry.authStorage.close();
	}
	for (const dir of dirs.splice(0)) dir.removeSync();
});

test("Studio selects registered backends, reports native failure and recovery, and preserves session precedence", async () => {
	const dir = TempDir.createSync("studio-todo-");
	dirs.push(dir);
	const authStorage = createInMemoryAuthStorage();
	const lists: TodoPhase[][] = [];
	let reject = false;
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(),
		extensions: [
			pi => {
				pi.registerTodoBackend({
					id: "tracker",
					label: "Tracker",
					replace: phases => {
						if (reject) throw Error("Tracker offline");
						lists.push(phases);
					},
				});
			},
		],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: ["read", "todo"],
	});
	sessions.push(session);
	const errors: string[] = [];
	session.extensionRunner!.onError(error => {
		if (error.event === "todo_backend") errors.push(error.error);
	});
	await session.extensionRunner!.emit({ type: "session_start" });
	session.commitTodoPhases([{ name: "Work", tasks: [{ content: "Keep user draft", status: "pending" }] }]);
	const service = new StudioTodoBackendService(session),
		sessionId = session.sessionId;
	await service.execute({ kind: "todo.backend.set", sessionId, backend: "tracker", scope: "session" });
	await session.extensionRunner!.todoBackendSettled();
	expect(lists[0]?.[0]?.tasks[0]?.content).toBe("Keep user draft");
	expect((await service.execute({ kind: "todo.backends.get", sessionId })).sync.state).toBe("synced");
	await service.execute({ kind: "todo.backend.set", sessionId, backend: "native", scope: "global" });
	expect((await service.execute({ kind: "todo.backends.get", sessionId })).selected).toBe("tracker");
	reject = true;
	session.commitTodoPhases([{ name: "Work", tasks: [{ content: "Changed list", status: "pending" }] }]);
	await session.extensionRunner!.todoBackendSettled();
	expect((await service.execute({ kind: "todo.backends.get", sessionId })).sync.state).toBe("failed");
	expect(session.getTodoPhases()[0]?.tasks[0]?.content).toBe("Changed list");
	expect(errors.some(error => error.includes("Tracker offline"))).toBe(true);
	reject = false;
	await service.execute({ kind: "todo.backend.sync", sessionId });
	await session.extensionRunner!.todoBackendSettled();
	expect((await service.execute({ kind: "todo.backends.get", sessionId })).sync.state).toBe("synced");
	expect(lists.at(-1)?.[0]?.tasks[0]?.content).toBe("Changed list");
});
