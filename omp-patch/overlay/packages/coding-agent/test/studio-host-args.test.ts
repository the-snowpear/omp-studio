import { describe, expect, test, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("studio-host launch arguments", () => {
	test("parses the studio-host mode and Bridge configuration", () => {
		const parsed = parseArgs([
			"--mode",
			"studio-host",
			"--bridge-endpoint",
			"omp-studio-test",
			"--bridge-token-file",
			"C:\\temp\\omp-studio.token",
			"--bridge-runtime-epoch",
			"7",
		]);

		expect(parsed.mode).toBe("studio-host");
		expect(parsed.bridgeEndpoint).toBe("omp-studio-test");
		expect(parsed.bridgeTokenFile).toBe("C:\\temp\\omp-studio.token");
		expect(parsed.bridgeRuntimeEpoch).toBe(7);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});

	test("supports the equals form for studio-host mode", () => {
		expect(parseArgs(["--mode=studio-host"]).mode).toBe("studio-host");
	});

	test("creates a distinct Studio session even when CLI auto-resume is enabled", async () => {
		using directory = TempDir.createSync("@omp-studio-fresh-");
		const previous = SessionManager.create(directory.path(), directory.path());
		previous.appendMessage({ role: "user", content: "Existing session", timestamp: Date.now() });
		let created: SessionManager | undefined;
		const recent = vi.spyOn(SessionManager, "continueRecent").mockResolvedValue(previous);
		const defaultDirectory = vi.spyOn(SessionManager, "getDefaultSessionDir").mockReturnValue(directory.path());
		try {
			const parsed = parseArgs(["--mode", "studio-host"]);
			created = await createSessionManager(parsed, directory.path(), Settings.isolated({ autoResume: true }));
			expect(created?.getSessionId()).not.toBe(previous.getSessionId());
			expect(created?.getEntries()).toEqual([]);
			expect(parsed.continue).not.toBe(true);
			expect(recent).not.toHaveBeenCalled();
		} finally {
			recent.mockRestore();
			defaultDirectory.mockRestore();
			if (created !== previous) await created?.close();
			await previous.close();
		}
	});

	test("keeps explicit Studio resume and ordinary CLI auto-resume", async () => {
		using directory = TempDir.createSync("@omp-studio-resume-");
		const previous = SessionManager.create(directory.path(), directory.path());
		previous.appendMessage({ role: "user", content: "Existing session", timestamp: Date.now() });
		await previous.ensureOnDisk();
		await previous.close();
		const recent = vi.spyOn(SessionManager, "continueRecent").mockResolvedValue(previous);
		let resumed: SessionManager | undefined;
		try {
			const settings = Settings.isolated({ autoResume: true });
			resumed = await createSessionManager(
				parseArgs(["--mode", "studio-host", "--resume", previous.getSessionFile()!]),
				directory.path(),
				settings,
			);
			expect(resumed?.getSessionId()).toBe(previous.getSessionId());
			const continued = await createSessionManager(
				parseArgs(["--mode", "studio-host", "--continue"]),
				directory.path(),
				settings,
			);
			expect(continued?.getSessionId()).toBe(previous.getSessionId());
			const parsed = parseArgs([]);
			const cli = await createSessionManager(parsed, directory.path(), settings);
			expect(cli?.getSessionId()).toBe(previous.getSessionId());
			expect(parsed.continue).toBe(true);
		} finally {
			recent.mockRestore();
			await resumed?.close();
			await previous.close();
		}
	});

	test("rejects an invalid Runtime epoch", () => {
		expect(() => parseArgs(["--bridge-runtime-epoch", "0"])).toThrow("positive safe integer");
	});
});
