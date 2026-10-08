import * as fs from "node:fs/promises";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import type {
	SessionTitleCard,
	SessionTitleRow,
	SessionTitlesOperation,
	SessionTitlesResult,
} from "../session-titles-protocol";
import { SessionControlError } from "./session-control-service";
const MAX_BYTES = 8 * 1024 * 1024;
function clean(value: string, max: number): string {
	return sanitizeText(value)
		.replace(/[\x00-\x1f]/g, " ")
		.trim()
		.slice(0, max);
}
function card(value: SessionTitleCard | undefined): SessionTitleCard | undefined {
	if (!value || typeof value.code !== "string" || !/^[A-Z0-9]{1,6}$/.test(value.code)) return;
	return {
		code: value.code,
		...(typeof value.emoji === "string" && value.emoji.length <= 32 && clean(value.emoji, 32)
			? { emoji: clean(value.emoji, 32) }
			: {}),
		...(typeof value.nf === "string" && /^nf-[a-z0-9_-]{1,125}$/.test(value.nf) ? { nf: value.nf } : {}),
	};
}
export class StudioSessionTitlesService {
	readonly #cache = new LRUCache<string, { identity: string; row: SessionTitleRow }>({ max: 128 });
	constructor(readonly session: AgentSession) {}
	async execute(operation: SessionTitlesOperation): Promise<SessionTitlesResult> {
		const check = () => {
			if (operation.sessionId !== this.session.sessionId)
				throw new SessionControlError("COMMAND_BLOCKED", "Session changed during title inspection");
		};
		check();
		const manager = this.session.sessionManager;
		const targets =
			operation.targetSessionIds.includes(operation.sessionId) && operation.targetSessionIds.length === 1
				? []
				: await SessionManager.list(manager.getCwd(), manager.getSessionDir());
		check();
		const rows: SessionTitleRow[] = [];
		let budget = 32 * 1024 * 1024;
		for (const id of operation.targetSessionIds) {
			check();
			if (id === operation.sessionId) {
				const title = manager.getSessionName(),
					nativeCard = card(manager.getSessionTitleCard());
				rows.push({
					sessionId: id,
					state: "available",
					...(title ? { title: clean(title, 1024) } : {}),
					...(manager.titleSource ? { source: manager.titleSource } : {}),
					...(title && nativeCard ? { card: nativeCard } : {}),
				});
				continue;
			}
			const target = targets.find(row => row.id === id);
			if (!target) {
				rows.push({ sessionId: id, state: "missing" });
				continue;
			}
			try {
				const stat = await fs.stat(target.path);
				check();
				if (stat.size > MAX_BYTES || stat.size > budget) {
					rows.push({
						sessionId: id,
						state: "unavailable",
						reason: "Title metadata exceeds the inspection budget",
					});
					continue;
				}
				const identity = stat.dev + ":" + stat.ino + ":" + stat.size + ":" + stat.mtimeMs + ":" + stat.ctimeMs,
					cached = this.#cache.get(target.path);
				if (cached?.identity === identity && cached.row.sessionId === id) {
					rows.push(cached.row);
					continue;
				}
				budget -= stat.size;
				const saved = await SessionManager.peekSessionTitle(target.path);
				check();
				const after = await fs.stat(target.path);
				check();
				if (
					saved.sessionId !== id ||
					after.size !== stat.size ||
					after.mtimeMs !== stat.mtimeMs ||
					after.ctimeMs !== stat.ctimeMs
				)
					throw new Error("Session changed while reading title metadata; refresh to try again");
				const nativeCard = card(saved.card),
					title = saved.title && clean(saved.title, 1024);
				const row: SessionTitleRow = {
					sessionId: id,
					state: "available",
					...(title ? { title } : {}),
					...(saved.source ? { source: saved.source } : {}),
					...(title && nativeCard ? { card: nativeCard } : {}),
				};
				this.#cache.set(target.path, { identity, row });
				rows.push(row);
			} catch (cause) {
				check();
				rows.push({
					sessionId: id,
					state: "unavailable",
					reason:
						clean(cause instanceof Error ? cause.message : String(cause), 512) || "Title metadata unavailable",
				});
			}
		}
		check();
		return { rows };
	}
}
