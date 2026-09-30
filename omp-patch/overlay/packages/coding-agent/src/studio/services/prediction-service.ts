import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, relative } from "node:path";
import { Database } from "bun:sqlite";
import { getAgentDir, getHistoryDbPath, withFileLock } from "@oh-my-pi/pi-utils";
import { TextPredictionClient } from "../../predict/client";
import { cfgSpellingAutocomplete } from "../../modes/settings";
import type { AgentSession } from "../../session/agent-session";
import { readForeignPrompts } from "../../predict/foreign-history";
import { ensureSmolLmWeights, smolLmWeightsReady, SMOLLM_TOTAL_BYTES } from "../../predict/smollm-weights";
import type { PredictionControlAction, PredictionControlState, PredictionResult } from "../prediction-protocol";

export interface StudioPredictionQuery {
	sessionId: string;
	version: number;
	before: string;
	prefix: string;
}
export type StudioPredictionResult = PredictionResult;

/** Drafts only cross complete(); only confirmed submissions enter this private history. */
export class StudioPredictionService {
	readonly directory: string;
	readonly client: Pick<TextPredictionClient, "complete" | "sync" | "close"> &
		Partial<Pick<TextPredictionClient, "stop">>;
	#download: PredictionControlState["download"] = { state: "idle", loaded: 0, total: SMOLLM_TOTAL_BYTES };
	#downloadAbort: AbortController | undefined;
	get running(): boolean {
		return this.#download.state === "running";
	}
	#disposed = false;
	#unsubscribe: (() => void) | undefined;
	constructor(
		readonly session: Pick<AgentSession, "sessionId" | "settings"> & Partial<Pick<AgentSession, "subscribe">>,
		options: { directory?: string; client?: Pick<TextPredictionClient, "complete" | "sync" | "close"> } = {},
	) {
		this.directory = options.directory ?? join(getAgentDir(), "studio", "prediction");
		this.client = options.client ?? new TextPredictionClient(this.directory, false, false);
		this.#unsubscribe = session.subscribe?.(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const message = event.message;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join("\n");
			const id = createHash("sha256")
				.update(session.sessionId + ":" + message.timestamp + ":" + text)
				.digest("hex");
			void this.observeSent(id, text).catch(() => {
				/* Prediction storage failures must not interrupt conversation. */
			});
		});
	}
	#access<T>(operation: () => Promise<T>): Promise<T> {
		// Unlike Windows named mutexes, macOS flock needs the sidecar's parent on disk.
		// Create only the private namespace; draft queries never create a history database.
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		return withFileLock(this.directory + ".access", operation);
	}
	async query(input: StudioPredictionQuery): Promise<StudioPredictionResult> {
		return this.#access(() => this.#query(input));
	}
	async #query(input: StudioPredictionQuery): Promise<StudioPredictionResult> {
		if (this.#disposed || input.sessionId !== this.session.sessionId) throw Error("Prediction session unavailable");
		if (
			!Number.isSafeInteger(input.version) ||
			input.version < 0 ||
			input.before.length > 8192 ||
			input.prefix.length > 256 ||
			input.before.includes("\0") ||
			input.prefix.includes("\0")
		)
			throw Error("Invalid prediction query");
		const method = cfgSpellingAutocomplete.get(this.session.settings);
		if (method === "off") return { version: input.version, suffix: null, engine: "off" };
		// Model downloads require a separate reviewed action, never a draft query.
		if (method === "apple" || (method === "smollm" && !(await smolLmWeightsReady())))
			return {
				version: input.version,
				suffix: null,
				engine: "off",
				unavailable: "Choose a downloaded Studio prediction engine",
			};
		const engine = method === "smollm" ? "smollm" : "ngram";
		const result = await this.client.complete(engine, input.before, input.prefix);
		if (this.#disposed || input.sessionId !== this.session.sessionId)
			return { version: input.version, suffix: null, engine: "off" };
		const suffix = result.suggestion?.suffix;
		return {
			version: input.version,
			suffix: typeof suffix === "string" && suffix.length <= 256 && !/[\r\n\0]/.test(suffix) ? suffix : null,
			engine,
		};
	}
	/** Called with the authoritative accepted submission identity, never with editor changes. */
	async observeSent(id: string, text: string): Promise<void> {
		if (this.#disposed || cfgSpellingAutocomplete.get(this.session.settings) === "off" || !text.trim()) return;
		if (!id || id.length > 1024 || text.length > 65536) throw Error("Invalid prediction submission");
		await this.#access(async () => {
			if (this.#disposed) return;
			const history = this.#openHistory();
			try {
				history.query("INSERT OR IGNORE INTO history(submission,prompt) VALUES(?,?)").run(id, text);
			} finally {
				history.close();
			}
			this.client.sync();
		});
	}
	#openHistory(): Database {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const db = new Database(getHistoryDbPath(this.directory));
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, submission TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL)",
		);
		return db;
	}
	async control(action: PredictionControlAction): Promise<PredictionControlState> {
		if (this.#disposed) throw Error("Prediction unavailable");
		if (action === "download" && this.#download.state !== "running") {
			const abort = new AbortController();
			this.#downloadAbort = abort;
			this.#download = { state: "running", loaded: 0, total: SMOLLM_TOTAL_BYTES };
			void ensureSmolLmWeights({
				signal: abort.signal,
				onProgress: loaded => {
					this.#download.loaded = loaded;
				},
			})
				.then(() => {
					this.#download.state = "completed";
				})
				.catch(() => {
					this.#download.state = abort.signal.aborted ? "cancelled" : "failed";
					if (!abort.signal.aborted) this.#download.error = "Model download failed; retry explicitly";
				});
		}
		if (action === "cancel") this.#downloadAbort?.abort();
		return this.#access(async () => {
			if (action === "clear") {
				if (!this.client.stop) throw Error("Prediction daemon control unavailable");
				await this.client.stop();
				// Fixed children of Studio's own namespace; never remove the shared model cache.
				const root = resolve(this.directory);
				const target = resolve(root, "predict");
				if (relative(root, target) !== "predict") throw Error("Invalid prediction state directory");
				await rm(target, { recursive: true, force: true });
				const history = this.#openHistory();
				try {
					history.exec(
						"PRAGMA secure_delete=ON; DELETE FROM history; DELETE FROM sqlite_sequence WHERE name='history'; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;",
					);
				} finally {
					history.close();
				}
			}
			const history = this.#openHistory();
			try {
				if (action === "import") {
					const prompts = await readForeignPrompts();
					let bytes = 0;
					const insert = history.query("INSERT OR IGNORE INTO history(submission,prompt) VALUES(?,?)");
					history.transaction(() => {
						for (const text of prompts.slice(0, 100000)) {
							bytes += Buffer.byteLength(text);
							if (bytes > 64 * 1024 * 1024) break;
							if (text.length > 65536) continue;
							insert.run("import:" + createHash("sha256").update(text).digest("hex"), text);
						}
					})();
					this.client.sync();
				}
				const count = history.query<{ count: number }, []>("SELECT count(*) AS count FROM history").get()!.count;
				return { corpusCount: count, modelReady: await smolLmWeightsReady(), download: { ...this.#download } };
			} finally {
				history.close();
			}
		});
	}
	dispose(): void {
		this.#disposed = true;
		this.#downloadAbort?.abort();
		this.#unsubscribe?.();
		this.client.close();
	}
}
