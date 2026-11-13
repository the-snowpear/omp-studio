import { redactSensitiveCredentials, withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { randomUUID } from "node:crypto";
import type { ContextViewData, ContextViewEntry } from "@oh-my-pi/pi-tui/chrome/context-view-model";
import { contextCategoryDescriptor } from "@oh-my-pi/pi-tui/chrome/context-view-model";
import type { AgentSession } from "../../session/agent-session";
import { buildSessionContextView } from "../../session/context-view";
import type {
	ContextCategoryId,
	ContextCategorySummary,
	ContextEntrySummary,
	ContextViewIndex,
	ContextViewOperation,
	ContextViewResultMap,
	ContextViewSourceMarker,
} from "../context-view-protocol";
import { truncateUtf8 } from "./conversation-sanitizer";
import { SessionControlError } from "./session-control-service";

const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const ENTRY_BYTES = 256 * 1024;
const PAGE_CHARS = 24000;
const PAGE_ENTRIES = 50;
/** Characters of redacted body kept for the in-list preview. */
const PREVIEW_CHARS = 480;

interface StoredEntry {
	summary: ContextEntrySummary;
	text: string;
	sourceMarkers: ContextViewSourceMarker[];
	/** Lowercased label + info + path + text, built once because snapshots are immutable. */
	lowered: string;
	truncated: boolean;
}
interface Snapshot {
	index: ContextViewIndex;
	entries: Map<string, StoredEntry>;
	/** Entry ids per category id and per child group key. */
	groups: Map<string, string[]>;
	childOwner: Map<string, ContextCategoryId>;
}

/** Slice a preview without splitting a surrogate pair. */
function slicePreview(text: string, max: number): string {
	let end = Math.min(text.length, max);
	if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
	return text.slice(0, end);
}

/** Map native source offsets through redaction without weakening whole-text credential redaction. */
function redactEntrySources(
	entry: ContextViewEntry,
	redact: (text: string) => string,
): {
	text: string;
	sourceMarkers: ContextViewSourceMarker[];
	linksOmitted: boolean;
} {
	const text = redact(entry.text);
	if (!entry.sourceMarkers?.length) return { text, sourceMarkers: [], linksOmitted: false };
	const parts: string[] = [];
	const sourceMarkers: ContextViewSourceMarker[] = [];
	let cursor = 0;
	let length = 0;
	for (const marker of entry.sourceMarkers) {
		const before = redact(entry.text.slice(cursor, marker.start));
		const shown = redact(entry.text.slice(marker.start, marker.end));
		parts.push(before, shown);
		length += before.length;
		sourceMarkers.push({ ...marker, start: length, end: length + shown.length });
		length += shown.length;
		cursor = marker.end;
	}
	parts.push(redact(entry.text.slice(cursor)));
	// A credential matcher can span a marker boundary. In that case the whole
	// redacted text wins and no guessed offset is exposed as a source link.
	if (parts.join("") !== text) return { text, sourceMarkers: [], linksOmitted: true };
	return { text, sourceMarkers, linksOmitted: false };
}

/** Read-on-open native context snapshot. Body text is never retained in receipts or global state. */
export class StudioContextViewService {
	#snapshot: Snapshot | undefined;
	constructor(readonly session: AgentSession) {}
	#redactText(text: string): string {
		return withCredentialRedaction(true, () =>
			redactSensitiveCredentials(this.session.obfuscator?.obfuscate(text) ?? text),
		);
	}
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
			// A search spans the whole category; a group key only narrows browsing.
			const key = selected.childKey && !search ? selected.childKey : selected.category;
			if (key !== selected.category && snapshot.childOwner.get(key) !== selected.category)
				throw new SessionControlError("INVALID_ARGUMENT", "Unknown context group");
			const ids = snapshot.groups.get(key);
			if (!ids) throw new SessionControlError("INVALID_ARGUMENT", "Unknown context category");
			const matched = ids
				.map(id => snapshot.entries.get(id)!)
				.filter(entry => !search || entry.lowered.includes(search));
			const focus =
				selected.focusEntryId && selected.offset === undefined
					? matched.findIndex(entry => entry.summary.id === selected.focusEntryId)
					: -1;
			const pageOffset = focus < 0 ? offset : Math.floor(focus / PAGE_ENTRIES) * PAGE_ENTRIES;
			const page = matched.slice(pageOffset, pageOffset + PAGE_ENTRIES).map(entry => entry.summary);
			return {
				entries: page,
				total: matched.length,
				...(pageOffset + page.length < matched.length ? { nextOffset: pageOffset + page.length } : {}),
			} as ContextViewResultMap[K];
		}
		const entry = snapshot.entries.get(selected.entryId);
		if (!entry) throw new SessionControlError("INVALID_ARGUMENT", "Context entry is unavailable");
		let end = Math.min(entry.text.length, offset + PAGE_CHARS);
		const crossing = entry.sourceMarkers.find(
			marker => marker.start > offset && marker.start < end && marker.end > end,
		);
		if (crossing) end = crossing.start;
		if (end < entry.text.length && /[\uD800-\uDBFF]/u.test(entry.text[end - 1] ?? "")) end--;
		const sourceMarkers = entry.sourceMarkers
			.filter(marker => marker.start >= offset && marker.end <= end)
			.map(marker => ({
				start: marker.start - offset,
				end: marker.end - offset,
				category: marker.category,
				...(marker.entryId && snapshot.entries.has(marker.entryId) ? { entryId: marker.entryId } : {}),
			}));
		return {
			entryId: selected.entryId,
			text: entry.text.slice(offset, end),
			totalChars: entry.text.length,
			truncated: entry.truncated,
			...(sourceMarkers.length ? { sourceMarkers } : {}),
			...(end < entry.text.length ? { nextOffset: end } : {}),
		} as ContextViewResultMap[K];
	}

	#open(): ContextViewIndex {
		this.dispose();
		const native: ContextViewData = buildSessionContextView(this.session);
		const entries = new Map<string, StoredEntry>();
		const groups = new Map<string, string[]>();
		const childOwner = new Map<string, ContextCategoryId>();
		const childKeyById = new Map<string, string>();
		for (const category of native.categories)
			for (const child of category.children ?? []) {
				if (!child.key) continue;
				childOwner.set(child.key, category.id);
				for (const entry of child.entries) childKeyById.set(entry.id, child.key);
			}

		let bytes = 0,
			truncated = false,
			linksOmitted = false;
		for (const category of native.categories) {
			const ids: string[] = [];
			const add = (entry: ContextViewEntry) => {
				if (ids.length >= 2000) {
					truncated = true;
					return;
				}
				const redacted = redactEntrySources(entry, text => this.#redactText(text));
				linksOmitted ||= redacted.linksOmitted;
				const text = truncateUtf8(redacted.text, Math.min(ENTRY_BYTES, Math.max(0, SNAPSHOT_BYTES - bytes)));
				bytes += Buffer.byteLength(text.text);
				truncated ||= text.truncated;
				const childKey = childKeyById.get(entry.id);
				ids.push(entry.id);
				entries.set(entry.id, {
					text: text.text,
					truncated: text.truncated,
					sourceMarkers: redacted.sourceMarkers.filter(marker => marker.end <= text.text.length),
					lowered: `${entry.label} ${entry.info ?? ""} ${entry.path ?? ""} ${text.text}`.toLowerCase(),
					summary: {
						id: entry.id,
						label: entry.label,
						tokens: entry.tokens,
						bytes: Buffer.byteLength(text.text),
						...(entry.info ? { info: entry.info } : {}),
						...(entry.path ? { path: entry.path } : {}),
						...(entry.interrupted ? { interrupted: true } : {}),
						...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
						...(entry.callId ? { callId: entry.callId } : {}),
						...(childKey ? { childKey } : {}),
						...(entry.thinkingGroup
							? {
									thinkingGroup: {
										id: entry.thinkingGroup.id,
										label: entry.thinkingGroup.label,
										tokens: entry.thinkingGroup.tokens,
										...(entry.thinkingGroup.interrupted ? { interrupted: true } : {}),
									},
								}
							: {}),
						preview: slicePreview(text.text, PREVIEW_CHARS),
					},
				});
			};
			for (const entry of category.entries) add(entry);
			groups.set(category.id, ids);
			for (const child of category.children ?? []) {
				if (!child.key) continue;
				// Truncated entries never reached the store, so their groups shrink with them.
				groups.set(
					child.key,
					child.entries.map(entry => entry.id).filter(id => entries.has(id)),
				);
			}
		}

		const breakdown = native.breakdown;
		const categories: ContextCategorySummary[] = native.categories.map(category => {
			const descriptor = contextCategoryDescriptor(category.id);
			return {
				id: category.id,
				label: category.label,
				tokens: category.tokens,
				entries: groups.get(category.id)?.length ?? 0,
				...(descriptor.overviewLabel ? { overviewLabel: descriptor.overviewLabel } : {}),
				...(descriptor.openable === false ? { openable: false as const } : {}),
				...((category.children?.length ?? 0) > 0
					? {
							children: category
								.children!.filter(child => child.key !== undefined)
								.map(child => ({
									id: category.id,
									key: child.key!,
									label: child.label,
									tokens: child.tokens,
									entries: groups.get(child.key!)?.length ?? 0,
								})),
						}
					: {}),
			};
		});

		const notices = (native.notices ?? []).map(notice => this.#redactText(notice));
		if (linksOmitted)
			notices.push(
				"Some source links are unavailable after credential redaction; the fully redacted text is shown.",
			);
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
			categories,
			...(notices.length ? { notices } : {}),
			...(breakdown.model
				? { model: { id: breakdown.model.id, ...(breakdown.model.name ? { name: breakdown.model.name } : {}) } }
				: {}),
			...(breakdown.snapcompact
				? {
						snapcompact: {
							visionCapable: breakdown.snapcompact.visionCapable,
							savedTokens: breakdown.snapcompact.savedTokens,
						},
					}
				: {}),
		};
		this.#snapshot = { index, entries, groups, childOwner };
		return index;
	}
}
