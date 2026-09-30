import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { getHistoryDbPath } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { cfgSpellingAutocomplete } from "../src/modes/settings";
import { StudioPredictionService } from "../src/studio/services/prediction-service";

test("draft queries never persist, and only accepted unique submissions train the namespace", async () => {
	const directory = mkdtempSync(join(tmpdir(), "omp-studio-prediction-test-"));
	let calls = 0;
	const client = {
		complete: async () => {
			calls++;
			return { engine: "ngram" as const, suggestion: { suffix: " world" } as never };
		},
		sync: () => {},
		close: () => {},
	};
	const settings = Settings.isolated();
	const service = new StudioPredictionService({ sessionId: "s", settings }, { directory, client });
	try {
		expect(await service.query({ sessionId: "s", version: 1, before: "secret draft", prefix: "w" })).toEqual({
			version: 1,
			suffix: " world",
			engine: "ngram",
		});
		expect(existsSync(getHistoryDbPath(directory))).toBe(false);
		await service.observeSent("submission-1", "sent text");
		await service.observeSent("submission-1", "sent text");
		const db = new Database(getHistoryDbPath(directory), { readonly: true });
		try {
			expect(db.query("SELECT prompt FROM history").all()).toEqual([{ prompt: "sent text" }]);
		} finally {
			db.close();
		}
		cfgSpellingAutocomplete.override(settings, "off");
		await service.query({ sessionId: "s", version: 2, before: "private", prefix: "" });
		expect(calls).toBe(1);
		cfgSpellingAutocomplete.override(settings, "smollm");
		await service.query({ sessionId: "s", version: 3, before: "private", prefix: "" });
		expect(calls).toBe(1);
	} finally {
		service.dispose();
	}
});
test("explicit corpus clear stops the daemon before deleting learned state", async () => {
	const directory = mkdtempSync(join(tmpdir(), "omp-studio-prediction-clear-"));
	let stopped = 0;
	const client = {
		complete: async () => ({ engine: "ngram" as const, suggestion: null }),
		sync: () => {},
		close: () => {},
		stop: async () => {
			stopped++;
			expect(existsSync(join(directory, "predict", "ngram", "state"))).toBe(true);
		},
	};
	const service = new StudioPredictionService(
		{ sessionId: "s", settings: Settings.isolated() },
		{ directory, client },
	);
	try {
		await service.observeSent("one", "ONLY_SENT_PRIVATE_SENTINEL");
		mkdirSync(join(directory, "predict", "ngram"), { recursive: true });
		writeFileSync(join(directory, "predict", "ngram", "state"), "learned");
		const status = await service.control("status");
		expect(status.corpusCount).toBe(1);
		expect(stopped).toBe(0);
		const cleared = await service.control("clear");
		expect(cleared.corpusCount).toBe(0);
		expect(stopped).toBe(1);
		expect(existsSync(join(directory, "predict"))).toBe(false);
		expect(readFileSync(getHistoryDbPath(directory)).includes(Buffer.from("ONLY_SENT_PRIVATE_SENTINEL"))).toBe(false);
	} finally {
		service.dispose();
	}
});
