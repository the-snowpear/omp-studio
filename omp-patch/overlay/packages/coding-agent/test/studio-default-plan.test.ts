import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { runStudioHostMode } from "../src/studio/studio-host-mode";

test("Studio applies the default Plan only to a fresh session", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-default-plan-"));
	const auth = await AuthStorage.create(join(directory, "auth.db"));
	try {
		for (const freshSession of [true, false]) {
			const session = new AgentSession({
				agent: new Agent(),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "plan.defaultOnStartup": true }),
				modelRegistry: new ModelRegistry(auth),
			});
			try {
				await runStudioHostMode(
					session,
					{ runtimeEpoch: 1 },
					async runtime => {
						expect(runtime.services.modes.state().plan?.status).toBe(freshSession ? "active" : undefined);
					},
					{ freshSession, createBridge: () => ({ start: async () => {}, stop: async () => {} }) },
				);
			} finally {
				await session.dispose();
			}
		}
	} finally {
		auth.close();
		await rm(directory, { recursive: true, force: true });
	}
});
