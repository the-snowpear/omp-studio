import * as fs from "node:fs/promises";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentRef } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { isAgentViewSession } from "../../session/agent-session-handle";
import type { SessionEntry } from "../../session/session-entries";
import { loadEntriesFromFile } from "../../session/session-loader";
import type { StudioAgentMessage, StudioAgentMessages } from "../runtime-views-protocol";
import { reconstructSessionBranch } from "./agent-conversation-service";
import { ownedStudioAgentRefs } from "./owned-sessions";

/** Newest messages returned; older ones are dropped and `truncated` says so. */
const MAX_MESSAGES = 500;
/** One body's cap; agents sometimes relay a whole task result. */
const MAX_BODY = 16 * 1024;

function body(text: string): string {
	return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

/**
 * Messages one agent received, read from its own session: the IRC bus keeps no
 * history, but every delivery lands in the recipient's transcript as an
 * `irc:incoming` record, or, for a parent's message to a busy child, as a user
 * steer that keeps the original sender and body in `parentIrc`.
 */
export function receivedAgentMessages(agentId: string, entries: readonly SessionEntry[]): StudioAgentMessage[] {
	const messages: StudioAgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType === "irc:incoming" && isRecord(entry.details)) {
			const details = entry.details;
			if (typeof details.from !== "string" || typeof details.message !== "string") continue;
			messages.push({
				id: typeof details.id === "string" || typeof details.id === "number" ? String(details.id) : entry.id,
				from: details.from,
				to: agentId,
				body: body(details.message),
				at: Date.parse(entry.timestamp) || 0,
				...(typeof details.replyTo === "string" && details.replyTo ? { replyTo: details.replyTo } : {}),
				...(details.broadcast === true ? { broadcast: true } : {}),
				...(details.progress === true ? { progress: true } : {}),
				...(details.wakeRelay === true ? { relay: true } : {}),
			});
			continue;
		}
		if (entry.type === "message" && entry.message.role === "user") {
			const steer = (entry.message as { parentIrc?: unknown }).parentIrc;
			if (!isRecord(steer) || typeof steer.from !== "string" || typeof steer.body !== "string") continue;
			const at = (entry.message as { timestamp?: unknown }).timestamp;
			messages.push({
				id: entry.id,
				from: steer.from,
				to: agentId,
				body: body(steer.body),
				at: typeof at === "number" ? at : Date.parse(entry.timestamp) || 0,
			});
		}
	}
	return messages;
}

/** Parked and finished agents are read from their session file; the parse is kept until the file changes. */
const fileCache = new Map<string, { stamp: string; messages: StudioAgentMessage[] }>();

async function fromFile(agentId: string, file: string): Promise<StudioAgentMessage[]> {
	let stamp: string;
	try {
		const stat = await fs.stat(file);
		stamp = `${agentId}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		fileCache.delete(file);
		return [];
	}
	const cached = fileCache.get(file);
	if (cached?.stamp === stamp) return cached.messages;
	const branch = reconstructSessionBranch(await loadEntriesFromFile(file))?.branch ?? [];
	const messages = receivedAgentMessages(agentId, branch);
	fileCache.set(file, { stamp, messages });
	return messages;
}

async function agentInbox(ref: AgentRef): Promise<StudioAgentMessage[]> {
	if (ref.session && isAgentViewSession(ref.session))
		return receivedAgentMessages(ref.id, ref.session.sessionManager.getBranch());
	return ref.sessionFile ? fromFile(ref.id, ref.sessionFile) : [];
}

/** Every agent-to-agent message in this session's swarm, oldest first. */
export async function readStudioAgentMessages(session: AgentSession): Promise<StudioAgentMessages> {
	const refs = ownedStudioAgentRefs(session);
	const files = new Set(refs.map(ref => ref.sessionFile).filter((file): file is string => file !== undefined));
	for (const file of fileCache.keys()) if (!files.has(file)) fileCache.delete(file);
	const inboxes = await Promise.all(refs.map(ref => agentInbox(ref).catch(() => [])));
	const seen = new Set<string>();
	const all: StudioAgentMessage[] = [];
	for (const message of inboxes.flat()) {
		const key = `${message.to}\u0000${message.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		all.push(message);
	}
	all.sort((a, b) => a.at - b.at);
	return { messages: all.slice(-MAX_MESSAGES), truncated: all.length > MAX_MESSAGES };
}
