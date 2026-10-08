import { expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioIdaDetailsService } from "../src/studio/services/ida-details-service";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../src/studio/workbench-protocol";

test("disabled IDA reports configuration status without launching a broker or probing Python", async () => {
	const service = new StudioIdaDetailsService({
		sessionId: "s",
		settings: Settings.isolated({ "ida.enabled": false }),
	} as AgentSession);
	const status = await service.execute({ kind: "ida.status.details", sessionId: "s" });
	expect(status).toMatchObject({ enabled: false, available: false, databases: [], reason: "IDA is disabled." });
	validateWorkbenchResult("ida.status.details", status);
	await expect(
		service.execute({ kind: "ida.run", sessionId: "old", id: "db", code: "print(1)", timeoutMs: 1000 }),
	).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	expect(() =>
		validateWorkbenchOperation({ kind: "ida.run", sessionId: "s", id: "db", code: "print(1)", timeoutMs: 400_000 }),
	).toThrow();
});

const python = Bun.which("python3") ?? Bun.which("python");
test.skipIf(!python)(
	"native worker checkpoints preserve both database states and block execution on backup failure",
	() => {
		const result = Bun.spawnSync(
			[
				python!,
				path.join(import.meta.dir, "studio-ida-checkpoint.py"),
				path.join(import.meta.dir, "../src/ida/worker.py"),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(new TextDecoder().decode(result.stderr)).toBe("");
		expect(result.exitCode).toBe(0);
	},
);
