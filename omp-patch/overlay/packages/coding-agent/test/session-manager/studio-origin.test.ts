import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { listSessionsReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { migrateToCurrentVersion } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { classifyStudioSessionOrigin } from "@oh-my-pi/pi-coding-agent/studio/session-origin";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const STUDIO_ORIGIN = "studio-host" as const;

describe("Studio session origin compatibility", () => {
	it("seeds the initial persisted session created by studio-host", async () => {
		using tempDir = TempDir.createSync("@omp-studio-origin-startup-");
		const parsed = parseArgs(["--mode", "studio-host", "--session-dir", tempDir.path()]);
		const manager = await createSessionManager(parsed, tempDir.path(), Settings.isolated());

		expect(manager?.getHeader()?.studioOrigin).toBe(STUDIO_ORIGIN);
	});

	it("persists optional Studio metadata without changing the upstream session version", async () => {
		using tempDir = TempDir.createSync("@omp-studio-origin-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), undefined, {
			studioOrigin: STUDIO_ORIGIN,
		});
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();

		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		const entries = await loadEntriesFromFile(file!);
		const header = entries[0] as SessionHeader;
		expect(header.version).toBe(3);
		expect(header.studioOrigin).toBe(STUDIO_ORIGIN);
		expect(migrateToCurrentVersion(structuredClone(entries) as FileEntry[])).toBe(false);

		const listed = await listSessionsReadOnly(tempDir.path(), new FileSessionStorage());
		expect(listed.map(session => session.id)).toContain(header.id);

		const reopened = await SessionManager.open(file!, tempDir.path(), undefined, { suppressBreadcrumb: true });
		expect(reopened.getHeader()?.studioOrigin).toBe(STUDIO_ORIGIN);
		await reopened.setSessionName("renamed in upstream", "user");
		const rewritten = (await loadEntriesFromFile(file!))[0] as SessionHeader;
		expect(rewritten.studioOrigin).toBe(STUDIO_ORIGIN);
	});

	it("keeps a resumed legacy CLI session unmarked while marking the next new Studio session", async () => {
		using tempDir = TempDir.createSync("@omp-studio-origin-legacy-");
		const legacy = SessionManager.create(tempDir.path(), tempDir.path());
		legacy.appendMessage(makeAssistantMessage());
		await legacy.flush();

		const reopened = await SessionManager.open(legacy.getSessionFile()!, tempDir.path(), undefined, {
			suppressBreadcrumb: true,
		});
		reopened.setNewSessionStudioOrigin(STUDIO_ORIGIN);
		expect(reopened.getHeader()?.studioOrigin).toBeUndefined();
		expect(classifyStudioSessionOrigin(reopened.getHeader()!)).toBe("cli");

		await reopened.newSession();
		expect(reopened.getHeader()?.studioOrigin).toBe(STUDIO_ORIGIN);
		expect(classifyStudioSessionOrigin(reopened.getHeader()!)).toBe("studio");
	});

	it("marks a fork created by Studio without changing the source session", async () => {
		using tempDir = TempDir.createSync("@omp-studio-origin-fork-");
		const source = SessionManager.create(tempDir.path(), tempDir.path());
		source.appendMessage(makeAssistantMessage());
		await source.flush();

		const forked = await SessionManager.forkFrom(
			source.getSessionFile()!,
			tempDir.path(),
			tempDir.path(),
			undefined,
			{ suppressBreadcrumb: true, studioOrigin: STUDIO_ORIGIN },
		);

		expect(source.getHeader()?.studioOrigin).toBeUndefined();
		expect(forked.getHeader()?.studioOrigin).toBe(STUDIO_ORIGIN);
		expect(forked.getHeader()?.parentSession).toBe(source.getSessionId());
	});

	it("treats absent or unknown metadata as CLI-compatible", () => {
		expect(classifyStudioSessionOrigin({})).toBe("cli");
		expect(classifyStudioSessionOrigin({ studioOrigin: "studio-host" })).toBe("studio");
		expect(classifyStudioSessionOrigin({ studioOrigin: "future-origin" })).toBe("cli");
	});
});
