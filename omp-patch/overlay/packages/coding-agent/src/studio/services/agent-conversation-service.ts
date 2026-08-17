import { randomBytes } from "node:crypto";
import type { AgentRef, AgentRegistry } from "../../registry/agent-registry";
import type { FileEntry, SessionEntry } from "../../session/session-entries";
import { loadEntriesFromFile } from "../../session/session-loader";
import type { ConversationTranscriptPage } from "../conversation-protocol";
import { readConversationTranscriptPage, StudioSessionTranscriptError } from "./session-transcript-service";

export class StudioAgentConversationError extends Error {
	constructor(
		readonly code: "AGENT_NOT_FOUND" | "TRANSCRIPT_UNAVAILABLE" | "CURSOR_STALE" | "INVALID_ARGUMENT",
		message: string,
	) {
		super(message);
		this.name = "StudioAgentConversationError";
	}
}

export type StudioAgentConversationLoadEntries = (filePath: string) => Promise<FileEntry[]>;

export type ReconstructSessionBranch = {
	sessionId: string;
	branchLeafId: string;
	branch: SessionEntry[];
};

export function reconstructSessionBranch(entries: readonly FileEntry[]): ReconstructSessionBranch | undefined {
	const header = entries.find(entry => entry.type === "session");
	if (header === undefined || typeof header.id !== "string" || header.id.length === 0) return undefined;
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (sessionEntries.length === 0) {
		return { sessionId: header.id, branchLeafId: "", branch: [] };
	}
	const byId = new Map<string, SessionEntry>();
	for (const entry of sessionEntries) {
		if (typeof entry.id === "string" && entry.id.length > 0) byId.set(entry.id, entry);
	}
	const leaf = sessionEntries.at(-1);
	if (leaf === undefined || typeof leaf.id !== "string" || leaf.id.length === 0) {
		return { sessionId: header.id, branchLeafId: "", branch: [] };
	}
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current !== undefined && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		// Annotated to break the circular inference between `current` and the
		// parent lookup that reassigns it.
		const parentId: string | null | undefined = current.parentId;
		current = parentId === null || parentId === undefined || parentId.length === 0 ? undefined : byId.get(parentId);
	}
	path.reverse();
	return { sessionId: header.id, branchLeafId: leaf.id, branch: path };
}

export class StudioAgentConversationService {
	readonly #registry: AgentRegistry;
	readonly #runtimeEpoch: () => number;
	readonly #loadEntries: StudioAgentConversationLoadEntries;
	readonly #secrets = new Map<string, Buffer>();

	constructor(options: {
		registry: AgentRegistry;
		runtimeEpoch: () => number;
		loadEntries?: StudioAgentConversationLoadEntries;
	}) {
		this.#registry = options.registry;
		this.#runtimeEpoch = options.runtimeEpoch;
		this.#loadEntries = options.loadEntries ?? loadEntriesFromFile;
	}

	async read(args: { agentId: string; cursor?: string; limit?: number }): Promise<ConversationTranscriptPage> {
		if (typeof args.agentId !== "string" || args.agentId.length === 0) {
			throw new StudioAgentConversationError("INVALID_ARGUMENT", "Agent id is invalid");
		}
		const captured = this.#capture(args.agentId);
		const runtimeEpoch = this.#runtimeEpoch();
		if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch <= 0) {
			throw new StudioAgentConversationError("INVALID_ARGUMENT", "Invalid runtime epoch");
		}
		const secret = this.#secretFor(args.agentId);
		let source: { sessionId: string; branchLeafId: string; branch: readonly SessionEntry[] };
		try {
			source = captured.session
				? this.#fromLiveSession(captured.session)
				: await this.#fromSessionFile(captured.sessionFile as string);
		} catch (error) {
			if (error instanceof StudioAgentConversationError || error instanceof StudioSessionTranscriptError) {
				throw error;
			}
			throw new StudioAgentConversationError("TRANSCRIPT_UNAVAILABLE", "Agent conversation could not be read");
		}
		this.#assertUnchanged(args.agentId, captured);
		try {
			return readConversationTranscriptPage(
				{
					runtimeEpoch,
					sessionId: source.sessionId,
					branchLeafId: source.branchLeafId,
					branch: source.branch,
				},
				{ cursor: args.cursor, limit: args.limit },
				secret,
			);
		} catch (error) {
			if (error instanceof StudioSessionTranscriptError) {
				if (error.code === "CURSOR_STALE") {
					throw new StudioAgentConversationError("CURSOR_STALE", error.message);
				}
				if (error.code === "INVALID_ARGUMENT") {
					throw new StudioAgentConversationError("INVALID_ARGUMENT", error.message);
				}
				throw new StudioAgentConversationError("TRANSCRIPT_UNAVAILABLE", error.message);
			}
			throw error;
		}
	}

	#capture(agentId: string): { ref: AgentRef; session: AgentRef["session"]; sessionFile: string | null } {
		const ref = this.#registry.get(agentId);
		if (ref === undefined) {
			throw new StudioAgentConversationError("AGENT_NOT_FOUND", `Agent "${agentId}" was not found`);
		}
		if (ref.session === null && (ref.sessionFile === null || ref.sessionFile.length === 0)) {
			throw new StudioAgentConversationError("TRANSCRIPT_UNAVAILABLE", `Agent "${agentId}" has no transcript`);
		}
		return { ref, session: ref.session, sessionFile: ref.sessionFile };
	}

	#assertUnchanged(
		agentId: string,
		captured: { ref: AgentRef; session: AgentRef["session"]; sessionFile: string | null },
	): void {
		const current = this.#registry.get(agentId);
		if (
			current === undefined ||
			current !== captured.ref ||
			current.session !== captured.session ||
			current.sessionFile !== captured.sessionFile
		) {
			throw new StudioAgentConversationError("CURSOR_STALE", "Agent session changed during transcript read");
		}
	}

	#fromLiveSession(session: NonNullable<AgentRef["session"]>): {
		sessionId: string;
		branchLeafId: string;
		branch: readonly SessionEntry[];
	} {
		const manager = session.sessionManager;
		const sessionId = manager.getSessionId();
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new StudioAgentConversationError("TRANSCRIPT_UNAVAILABLE", "Agent session has no identity");
		}
		return {
			sessionId,
			branchLeafId: manager.getLeafId() ?? "",
			branch: manager.getBranch(),
		};
	}

	async #fromSessionFile(sessionFile: string): Promise<{
		sessionId: string;
		branchLeafId: string;
		branch: readonly SessionEntry[];
	}> {
		let entries: FileEntry[];
		try {
			entries = await this.#loadEntries(sessionFile);
		} catch {
			throw new StudioAgentConversationError("TRANSCRIPT_UNAVAILABLE", "Agent conversation file could not be read");
		}
		const reconstructed = reconstructSessionBranch(entries);
		if (reconstructed === undefined) {
			throw new StudioAgentConversationError(
				"TRANSCRIPT_UNAVAILABLE",
				"Agent conversation file is empty or invalid",
			);
		}
		return reconstructed;
	}

	#secretFor(agentId: string): Buffer {
		const existing = this.#secrets.get(agentId);
		if (existing !== undefined) return existing;
		const secret = randomBytes(32);
		this.#secrets.set(agentId, secret);
		return secret;
	}
}
