import { expect, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { StudioMaintenanceService } from "../src/studio/services/maintenance-service";
import { StudioMediaFiles } from "../src/studio/services/media-files";
import { validateMaintenanceResult, type SessionExportResult } from "../src/studio/maintenance-protocol";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
test("native dump-all ZIP reaches the private output with main, child and request payload intact", async () => {
	const temp = TempDir.createSync("@studio-native-export-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Fixture"],
				tools: [],
				messages: [{ role: "user", content: "main export fixture", timestamp: 1 }],
			},
		}),
		sessionManager: SessionManager.create(temp.path(), temp.path()),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
		advisorTools: [],
	});
	try {
		const sessionFile = session.sessionManager.getSessionFile()!;
		const childFile = path.join(sessionFile.slice(0, -".jsonl".length), "Scout.jsonl");
		await Bun.write(
			childFile,
			[
				{ type: "session", version: 3, id: "scout", timestamp: "2026-10-08T00:00:00.000Z", cwd: temp.path() },
				{
					type: "message",
					id: "scout-message",
					parentId: null,
					timestamp: "2026-10-08T00:00:01.000Z",
					message: { role: "user", content: "child export fixture", timestamp: 1 },
				},
			]
				.map(row => JSON.stringify(row))
				.join("\n") + "\n",
		);
		const root = path.join(temp.path(), "private-files");
		const service = new StudioMaintenanceService(session, new StudioMediaFiles(root));
		const exported = (await service.execute({
			kind: "maintenance.session.export",
			sessionId: session.sessionId,
		})) as SessionExportResult;
		validateMaintenanceResult("maintenance.session.export", exported);
		expect(exported.format).toBe("archive");
		expect(exported.warnings).toEqual([]);
		const key = new Bun.CryptoHasher("sha256").update(session.sessionId).digest("hex");
		const bytes = await Bun.file(path.join(root, "outputs", key, exported.asset.artifactId + ".bin")).bytes();
		const entries = await readArchiveEntries({ bytes, format: "zip" });
		expect([...entries.keys()].sort()).toEqual(["llm-request.json", "session.md", "subagents/Scout.md"]);
		expect(new TextDecoder().decode(entries.get("session.md"))).toContain("main export fixture");
		expect(new TextDecoder().decode(entries.get("subagents/Scout.md"))).toContain("child export fixture");
		expect(JSON.parse(new TextDecoder().decode(entries.get("llm-request.json"))).messages).toHaveLength(1);
		expect(JSON.stringify(exported)).not.toContain("main export fixture");
	} finally {
		await session.dispose();
		await temp.remove();
	}
});
