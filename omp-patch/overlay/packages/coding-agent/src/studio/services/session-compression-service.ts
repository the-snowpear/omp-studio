import * as path from "node:path";
import { getAgentDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { collectGc, type CompressGcResult } from "../../cli/gc-cli";
import { cfgGcCompressAfterDays } from "../../cli/gc-settings";
import type { CompressCandidate } from "../../cli/gc-compress";
import type { AgentSession } from "../../session/agent-session";
import type {
	CompressionState,
	CompressionSummary,
	CompressionFile,
	SessionCompressionOperation,
} from "../session-compression-protocol";
import { SessionControlError } from "./session-control-service";
const clean = (error: unknown) =>
	sanitizeText(error instanceof Error ? error.message : String(error))
		.replaceAll("\0", "")
		.slice(0, 1024) || "Compression failed";
function summary(result: CompressGcResult, files: CompressionFile[], truncated: boolean): CompressionSummary {
	return {
		supported: result.supported,
		...(result.method ? { method: result.method } : {}),
		scanned: result.scanned,
		skippedLive: result.skippedLive,
		sessions: result.sessions,
		candidates: result.wouldCompress,
		compressed: result.compressed,
		bytes: result.bytes,
		allocatedBefore: result.allocatedBefore,
		allocatedAfter: result.allocatedAfter,
		files,
		truncated,
		errors: result.errors.slice(0, 20).map(clean),
	};
}
export class StudioSessionCompressionService {
	#state: CompressionState = { phase: "idle" };
	#owner = "";
	get running(): boolean {
		return this.#state.phase === "scanning" || this.#state.phase === "applying";
	}
	#candidates = new Map<string, CompressCandidate>();
	#disposed = false;
	constructor(readonly session: AgentSession) {}
	dispose(): void {
		this.#disposed = true;
		this.#candidates.clear();
	}
	async execute(operation: SessionCompressionOperation): Promise<CompressionState> {
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Compression session changed");
		if (operation.kind === "maintenance.compression.status")
			return this.#owner === operation.sessionId ? structuredClone(this.#state) : { phase: "idle" };
		if (["scanning", "applying"].includes(this.#state.phase))
			throw new SessionControlError("COMMAND_BLOCKED", "Compression is already in progress");
		const days = cfgGcCompressAfterDays.get(this.session.settings),
			applying = operation.kind === "maintenance.compression.apply";
		if (
			applying &&
			(this.#owner !== operation.sessionId ||
				this.#state.phase !== "ready" ||
				this.#state.token !== operation.token ||
				(this.#state.expiresAt ?? 0) < Date.now() ||
				this.#state.days !== days)
		)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Compression preview expired or settings changed; scan again",
			);
		this.#owner = operation.sessionId;
		if (!applying) this.#candidates.clear();
		this.#state = { phase: applying ? "applying" : "scanning", days };
		const files: CompressionFile[] = [];
		let truncated = false;
		try {
			const result = await collectGc({
				flags: {
					agentDir: getAgentDir(),
					apply: applying,
					blobs: false,
					archive: false,
					wal: false,
					stale: false,
					compress: true,
					compressAfterDays: days,
				},
				compressionCandidates: (sessionId, candidates) => {
					if (this.#disposed || operation.sessionId !== this.session.sessionId) return [];
					const selected: CompressCandidate[] = [];
					for (const candidate of candidates) {
						if (applying) {
							const approved = this.#candidates.get(candidate.path);
							if (
								!approved ||
								approved.bytes !== candidate.bytes ||
								approved.mtimeNs !== candidate.mtimeNs ||
								approved.ino !== candidate.ino
							)
								continue;
						} else if (this.#candidates.size >= 200) {
							truncated = true;
							continue;
						} else this.#candidates.set(candidate.path, candidate);
						selected.push(candidate);
						files.push({
							sessionId,
							name: path.relative(getAgentDir(), candidate.path).slice(0, 512),
							bytes: candidate.bytes,
							allocated: candidate.allocated,
						});
					}
					return selected;
				},
			});
			if (!result.compress) throw Error("Native compression result unavailable");
			const projected = summary(result.compress, files, truncated);
			this.#state =
				applying || !projected.supported || projected.errors.length > 0
					? { phase: "complete", days, summary: projected }
					: {
							phase: "ready",
							days,
							summary: projected,
							token: crypto.randomUUID(),
							expiresAt: Date.now() + 300000,
						};
			if (applying) this.#candidates.clear();
			return structuredClone(this.#state);
		} catch (cause) {
			this.#candidates.clear();
			this.#state = { phase: "failed", error: clean(cause) };
			throw cause;
		}
	}
}
