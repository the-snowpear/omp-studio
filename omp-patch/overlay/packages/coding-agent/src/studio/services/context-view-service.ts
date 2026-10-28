import { redactSensitiveCredentials, withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { randomUUID } from "node:crypto";
import type { ContextViewData, ContextViewEntry } from "@oh-my-pi/pi-tui/chrome/context-view-model";
import type { AgentSession } from "../../session/agent-session";
import { buildSessionContextView } from "../../session/context-view";
import type {
	ContextCategoryId,
	ContextEntrySummary,
	ContextViewIndex,
	ContextViewOperation,
	ContextViewResultMap,
} from "../context-view-protocol";
import { truncateUtf8 } from "./conversation-sanitizer";
import { SessionControlError } from "./session-control-service";

const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const ENTRY_BYTES = 256 * 1024;
const PAGE_CHARS = 24000;
interface StoredEntry {
	summary: ContextEntrySummary;
	text: string;
	truncated: boolean;
}
interface Snapshot {
	index: ContextViewIndex;
	entries: Map<string, StoredEntry>;
	categories: Map<ContextCategoryId, string[]>;
}

/** Read-on-open native context snapshot. Body text is never retained in receipts or global state. */
export class StudioContextViewService {
	#snapshot: Snapshot | undefined;
	constructor(readonly session: AgentSession) {}
	dispose(): void {
		this.#snapshot = undefined;
	}

	execute<K extends ContextViewOperation["kind"]>(
		operation: Extract<ContextViewOperation, { kind: K }>,
	): ContextViewResultMap[K] {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Context belongs to another session");
		if (operation.kind === "context.view.open") return this.#open() as ContextViewResultMap[K];
		const selected = operation as Exclude<ContextViewOperation, { kind: "context.view.open" }>;
		const snapshot = this.#snapshot;
		if (selected.kind === "context.view.release") {
			const released = snapshot?.index.snapshotId === selected.snapshotId;
			if (released) this.dispose();
			return { released } as ContextViewResultMap[K];
		}
		if (
			!snapshot ||
			snapshot.index.snapshotId !== selected.snapshotId ||
			snapshot.index.sessionId !== this.session.sessionId
		)
			throw new SessionControlError("COMMAND_BLOCKED", "Context snapshot expired; reopen the viewer");
		const offset = selected.offset ?? 0;
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new SessionControlError("INVALID_ARGUMENT", "Invalid context page");
		if (selected.kind === "context.view.list") {
			const search = (selected.search ?? "").trim().toLowerCase();
			const ids = snapshot.categories.get(selected.category);
			if (!ids) throw new SessionControlError("INVALID_ARGUMENT", "Unknown context category");
			const entries = ids
				.map(id => snapshot.entries.get(id)!)
				.filter(
					entry =>
						!search ||
						`${entry.summary.label} ${entry.summary.info ?? ""} ${entry.text}`.toLowerCase().includes(search),
				);
			const page = entries.slice(offset, offset + 50).map(entry => entry.summary);
			return {
				entries: page,
				total: entries.length,
				...(offset + page.length < entries.length ? { nextOffset: offset + page.length } : {}),
			} as ContextViewResultMap[K];
		}
		const entry = snapshot.entries.get(selected.entryId);
		if (!entry) throw new SessionControlError("INVALID_ARGUMENT", "Context entry is unavailable");
		let end = Math.min(entry.text.length, offset + PAGE_CHARS);
		if (end < entry.text.length && /[\uD800-\uDBFF]/u.test(entry.text[end - 1] ?? "")) end--;
		return {
			entryId: selected.entryId,
			text: entry.text.slice(offset, end),
			totalChars: entry.text.length,
			truncated: entry.truncated,
			...(end < entry.text.length ? { nextOffset: end } : {}),
		} as ContextViewResultMap[K];
	}

	#open(): ContextViewIndex {
		this.dispose();
		const native: ContextViewData = buildSessionContextView(this.session);
		const entries = new Map<string, StoredEntry>();
		const categories = new Map<ContextCategoryId, string[]>();
		let bytes = 0,
			truncated = false;
		for (const category of native.categories) {
			const ids: string[] = [];
			const add = (entry: ContextViewEntry) => {
				if (ids.length >= 2000) {
					truncated = true;
					return;
				}
				const redacted = withCredentialRedaction(true, () =>
					redactSensitiveCredentials(this.session.obfuscator?.obfuscate(entry.text) ?? entry.text),
				);
				const text = truncateUtf8(redacted, Math.min(ENTRY_BYTES, Math.max(0, SNAPSHOT_BYTES - bytes)));
				bytes += Buffer.byteLength(text.text);
				truncated ||= text.truncated;
				ids.push(entry.id);
				entries.set(entry.id, {
					text: text.text,
					truncated: text.truncated,
					summary: {
						id: entry.id,
						label: entry.label,
						tokens: entry.tokens,
						bytes: Buffer.byteLength(text.text),
						...(entry.info ? { info: entry.info } : {}),
						...(entry.path ? { path: entry.path } : {}),
						...(entry.interrupted ? { interrupted: true } : {}),
					},
				});
			};
			for (const entry of category.entries) add(entry);
			categories.set(category.id, ids);
		}
		const breakdown = native.breakdown;
		const index: ContextViewIndex = {
			sessionId: this.session.sessionId,
			snapshotId: randomUUID(),
			capturedAt: new Date().toISOString(),
			contextWindow: breakdown.contextWindow,
			usedTokens: breakdown.usedTokens,
			freeTokens: breakdown.freeTokens,
			bufferTokens: breakdown.autoCompactBufferTokens,
			thresholdTokens: breakdown.thresholdTokens ?? null,
			savedTokens: breakdown.snapcompact?.savedTokens ?? 0,
			truncated,
			categories: native.categories.map(category => ({
				id: category.id,
				label: category.label,
				tokens: category.tokens,
				entries: categories.get(category.id)?.length ?? 0,
			})),
		};
		this.#snapshot = { index, entries, categories };
		return index;
	}
}
