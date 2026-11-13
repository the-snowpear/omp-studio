import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as gc from "../src/cli/gc-cli";
import { cfgGcColdArchiveAfterDays, cfgGcStripAfterDays } from "../src/cli/gc-settings";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioMaintenanceService } from "../src/studio/services/maintenance-service";
import { StudioMediaFiles } from "../src/studio/services/media-files";
import type { GcPreview, SessionExportResult } from "../src/studio/maintenance-protocol";
import { validateMaintenanceResult } from "../src/studio/maintenance-protocol";
test("cleanup requires a fresh single-use preview and never applies during scanning", async () => {
	const settings = Settings.isolated(),
		session = { sessionId: "main", settings } as AgentSession;
	const collect = spyOn(gc, "collectGc").mockImplementation(async ({ flags }) => ({
		agentDir: "/private/agent",
		lockPath: "/private/gc.lock",
		apply: flags.apply === true,
		blobs: { referenced: 1, candidates: 3, wouldDelete: 2, deleted: flags.apply ? 2 : 0, bytes: 200, errors: [] },
	}));
	const clock = spyOn(Date, "now").mockReturnValue(1000);
	try {
		const service = new StudioMaintenanceService(session);
		await expect(
			service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: "unissued" }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(collect).not.toHaveBeenCalled();
		const preview = (await service.execute({
			kind: "maintenance.gc.preview",
			sessionId: "main",
			categories: ["blobs"],
		})) as GcPreview;
		validateMaintenanceResult("maintenance.gc.preview", preview);
		expect(collect.mock.calls[0]![0].flags.apply).toBe(false);
		const result = await service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: preview.token });
		expect(result).toMatchObject({ applied: true, rows: [{ category: "blobs", changed: 2 }] });
		expect(JSON.stringify(result)).not.toContain("/private");
		await expect(
			service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: preview.token }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const expired = (await service.execute({
			kind: "maintenance.gc.preview",
			sessionId: "main",
			categories: ["blobs"],
		})) as GcPreview;
		clock.mockReturnValue(expired.expiresAt + 1);
		await expect(
			service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: expired.token }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const changed = (await service.execute({
			kind: "maintenance.gc.preview",
			sessionId: "main",
			categories: ["blobs"],
		})) as GcPreview;
		cfgGcColdArchiveAfterDays.override(settings, 100);
		await expect(
			service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: changed.token }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(collect.mock.calls.filter(([args]) => args.flags.apply)).toHaveLength(1);
	} finally {
		clock.mockRestore();
		collect.mockRestore();
	}
});
test("replay stripping uses a native idle policy and single-use preview, separate from storage cleanup", async () => {
	const settings = Settings.isolated({ "gc.stripAfterDays": 30 });
	const directory = spyOn(settings, "getAgentDir").mockReturnValue("/isolated/studio-strip");
	const collect = spyOn(gc, "collectGc").mockImplementation(async ({ flags }) => ({
		agentDir: "/isolated/studio-strip",
		lockPath: "/isolated/studio-strip/gc.lock",
		apply: flags.apply === true,
		strip: {
			scanned: 8,
			skippedLive: flags.apply ? 2 : 1,
			wouldStrip: 3,
			stripped: flags.apply ? 2 : 0,
			records: 4,
			bytes: 512,
			errors: [],
		},
	}));
	try {
		const service = new StudioMaintenanceService({ sessionId: "main", settings } as AgentSession);
		const inherited = (await service.execute({
			kind: "maintenance.gc.preview",
			sessionId: "main",
			categories: [],
			strip: {},
		})) as GcPreview;
		expect(collect.mock.calls[0]![0].flags).toMatchObject({
			apply: false,
			strip: true,
			stripAfterDays: 30,
			compress: false,
			blobs: false,
			archive: false,
			wal: false,
			stale: false,
		});
		expect(inherited.summary.rows).toEqual([]);
		expect(inherited.summary.strip).toMatchObject({
			idleDays: 30,
			scope: "sessions-and-archives",
			candidates: 3,
			changed: 0,
			records: 4,
			bytes: 512,
		});
		cfgGcStripAfterDays.override(settings, 45);
		await expect(
			service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: inherited.token }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const explicit = (await service.execute({
			kind: "maintenance.gc.preview",
			sessionId: "main",
			categories: [],
			strip: { idleDays: 2 },
		})) as GcPreview;
		cfgGcStripAfterDays.override(settings, 60);
		const result = await service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: explicit.token });
		expect(result).toMatchObject({
			applied: true,
			rows: [],
			strip: { idleDays: 2, candidates: 3, changed: 2, skippedActive: 2 },
		});
		expect(collect.mock.calls.filter(([args]) => args.flags.apply)).toHaveLength(1);
		await expect(
			service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: explicit.token }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		collect.mockRestore();
		directory.mockRestore();
	}
});

test("collector errors remain visible and prevent applying a partial preview", async () => {
	const collect = spyOn(gc, "collectGc").mockResolvedValue({
		agentDir: "/private",
		lockPath: "/private/lock",
		apply: false,
		blobs: {
			referenced: 0,
			candidates: 0,
			wouldDelete: 0,
			deleted: 0,
			bytes: 0,
			errors: ["Cannot read the reference index"],
		},
	});
	try {
		const service = new StudioMaintenanceService({
			sessionId: "main",
			settings: Settings.isolated(),
		} as AgentSession);
		const preview = (await service.execute({
			kind: "maintenance.gc.preview",
			sessionId: "main",
			categories: ["blobs"],
		})) as GcPreview;
		expect(preview.summary.errors.some(error => error.includes("Cannot read the reference index"))).toBe(true);
		await expect(
			service.execute({ kind: "maintenance.gc.apply", sessionId: "main", token: preview.token }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(collect).toHaveBeenCalledTimes(1);
	} finally {
		collect.mockRestore();
	}
});
test("session export transfers bytes privately, exposes metadata only, and rejects concurrent exports", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-export-test-"));
	const release = Promise.withResolvers<void>();
	const session = {
		sessionId: "main",
		isStreaming: false,
		isCompacting: false,
		exportToHtml: async (file: string) => {
			await release.promise;
			await Bun.write(file, "<html>fixture full transcript</html>");
			return file;
		},
	} as unknown as AgentSession;
	try {
		const service = new StudioMaintenanceService(session, new StudioMediaFiles(directory));
		const pending = service.execute({ kind: "maintenance.session.export", format: "html", sessionId: "main" });
		await expect(
			service.execute({ kind: "maintenance.session.export", format: "html", sessionId: "main" }),
		).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
		});
		release.resolve();
		const exported = (await pending) as SessionExportResult;
		validateMaintenanceResult("maintenance.session.export", exported);
		expect(JSON.stringify(exported)).not.toContain("fixture full transcript");
		expect(JSON.stringify(exported)).not.toContain(directory);
		const status = await service.execute({ kind: "maintenance.export.status", sessionId: "main" });
		expect(status).toMatchObject({ phase: "complete", result: { id: exported.id } });
		const folder = (await fs.readdir(path.join(directory, "outputs")))[0]!;
		expect(await Bun.file(path.join(directory, "outputs", folder, exported.asset.artifactId + ".bin")).text()).toBe(
			"<html>fixture full transcript</html>",
		);
		expect(await fs.readdir(path.join(directory, "export-staging"))).toEqual([]);
	} finally {
		release.resolve();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
