import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";
import { StudioRuntimeSettingsService } from "../src/studio/services/runtime-settings-service";
import { HindsightApi } from "../src/hindsight/client";

test("Studio read settings change actual read output without writing user configuration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-read-settings-"));
	try {
		const file = join(directory, "example.txt");
		const markdown = join(directory, "example.md");
		await writeFile(file, "first\nsecond\nthird\nfourth\nfifth\n");
		await writeFile(markdown, "# Example\n\nHello **world**\n");
		const settings = Settings.isolated();
		const service = new StudioRuntimeSettingsService({ settings } as AgentSession);
		const session = {
			cwd: directory,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as ToolSession;
		const read = new ReadTool(session);
		await service.set("edit.mode", "replace", false);
		await service.set("readLineNumbers", true, false);
		await service.set("read.defaultLimit", 3, false);
		await service.set("read.summarize.enabled", false, false);
		const result = await read.execute("read", { path: file });
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("first");
		expect(text).toContain("third");
		expect(text).not.toContain("fourth");
		expect(text).toMatch(/1[:|]/);
		expect(service.activation().sources?.["read.defaultLimit"]).toBe("runtime");
		await service.set("read.renderMarkdown", true, false);
		const preview = await read.execute("markdown", { path: markdown });
		expect(preview.details?.contentType).toBe("text/markdown");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Hindsight service checks distinguish successful requests and authentication failures", async () => {
	let authorized = true;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (!authorized || request.headers.get("authorization") !== "Bearer test-secret")
				return new Response("denied", { status: 401 });
			return Response.json({ items: [] });
		},
	});
	try {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiToken": "test-secret" });
		const client = new HindsightApi({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "test-secret" });
		const session = {
			settings,
			settleMemoryBackend: async () => {},
			getHindsightSessionState: () => ({ client, bankId: "example" }),
		} as unknown as AgentSession;
		const service = new StudioRuntimeSettingsService(session);
		expect(JSON.stringify(service.activation())).not.toContain("test-secret");
		expect(service.activation().hindsightCredential).toEqual({ configured: true, source: "runtime" });
		expect(await service.checkHindsight()).toBe("ready");
		authorized = false;
		expect(await service.checkHindsight()).toBe("authentication-failed");
	} finally {
		server.stop(true);
	}
});
