import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { ModelAvailablePage, RuntimeAvailableModel } from "../model-services-protocol";
import { SessionControlError } from "./session-control-service";

const LEASE_MS = 60_000;
export const MODEL_AVAILABLE_MAX_ROWS = 10_000;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const ROW_BYTES = 32 * 1024;
const PAGE_BYTES = 512 * 1024;

interface Snapshot {
	sessionId: string;
	version: string;
	expiresAt: number;
	rows: string[];
	pages: Array<{ cursor: string; start: number; end: number }>;
	total: number;
	bytes: number;
	timer: Timer;
}

/** Immutable public JSON, bounded leases, and opaque per-page cursors. No native model/credential objects are retained. */
export class StudioModelAvailableSnapshots {
	readonly #cursors = new Map<string, { snapshotId: string; page: number }>();
	readonly #snapshots = new LRUCache<string, Snapshot>({
		max: 8,
		maxSize: 16 * 1024 * 1024,
		sizeCalculation: snapshot => snapshot.bytes,
		dispose: snapshot => {
			clearTimeout(snapshot.timer);
			for (const page of snapshot.pages) this.#cursors.delete(page.cursor);
		},
	});

	clear(): void {
		this.#snapshots.clear();
	}

	release(sessionId: string, snapshotId: string): boolean {
		const snapshot = this.#snapshots.peek(snapshotId);
		return snapshot?.sessionId === sessionId && this.#snapshots.delete(snapshotId);
	}

	create(
		sessionId: string,
		version: string,
		models: readonly RuntimeAvailableModel[],
		limit: number,
		total = models.length,
	): ModelAvailablePage {
		const rows: string[] = [];
		const sizes: number[] = [];
		let bytes = 1024;
		for (const model of models.slice(0, MODEL_AVAILABLE_MAX_ROWS)) {
			const row = JSON.stringify(model);
			const size = Buffer.byteLength(row, "utf8");
			if (size > ROW_BYTES) continue;
			// Account for UTF-16 storage and the worst-case one-row page/cursor overhead.
			const retained = row.length * 2 + 256;
			if (bytes + retained > SNAPSHOT_BYTES) break;
			rows.push(row);
			sizes.push(size);
			bytes += retained;
		}
		const pages: Snapshot["pages"] = [];
		let start = 0;
		do {
			let end = start,
				pageBytes = 0;
			while (end < rows.length && end - start < limit && pageBytes + sizes[end]! <= PAGE_BYTES) {
				pageBytes += sizes[end]!;
				end++;
			}
			pages.push({ cursor: crypto.randomUUID(), start, end });
			start = end;
		} while (start < rows.length);
		const snapshotId = crypto.randomUUID();
		const timer = setTimeout(() => this.#snapshots.delete(snapshotId), LEASE_MS);
		timer.unref();
		const snapshot: Snapshot = {
			sessionId,
			version,
			expiresAt: Date.now() + LEASE_MS,
			rows,
			pages,
			total,
			bytes,
			timer,
		};
		this.#snapshots.set(snapshotId, snapshot);
		for (let page = 0; page < pages.length; page++) this.#cursors.set(pages[page]!.cursor, { snapshotId, page });
		return this.read(sessionId, version, pages[0]!.cursor);
	}

	read(sessionId: string, version: string, cursor: string): ModelAvailablePage {
		const location = this.#cursors.get(cursor);
		const snapshot = location && this.#snapshots.get(location.snapshotId);
		if (
			!snapshot ||
			snapshot.sessionId !== sessionId ||
			snapshot.version !== version ||
			snapshot.expiresAt <= Date.now()
		) {
			if (location) this.#snapshots.delete(location.snapshotId);
			throw new SessionControlError("COMMAND_BLOCKED", "Model snapshot expired; read the catalog again", true, {
				reason: "model-snapshot-expired",
			});
		}
		const page = snapshot.pages[location!.page]!;
		const next = snapshot.pages[location!.page + 1];
		return {
			sessionId,
			snapshotId: location!.snapshotId,
			version,
			expiresAt: snapshot.expiresAt,
			cursor,
			...(next ? { nextCursor: next.cursor } : {}),
			total: snapshot.total,
			truncated: snapshot.rows.length < snapshot.total,
			models: snapshot.rows.slice(page.start, page.end).map(row => JSON.parse(row) as RuntimeAvailableModel),
		};
	}
}
