import { describe, expect, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

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

	test("rejects an invalid Runtime epoch", () => {
		expect(() => parseArgs(["--bridge-runtime-epoch", "0"])).toThrow("positive safe integer");
	});
});
