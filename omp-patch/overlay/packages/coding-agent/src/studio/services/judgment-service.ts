import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	getJudgmentBatch,
	listJudgmentBatches,
	retryJudgmentBatch,
	runEvalJudgmentBatch,
	type JudgmentBatchStatus,
} from "../../eval/judgment-batch-bridge";
import type { AgentSession } from "../../session/agent-session";
import {
	type JudgmentBatchItem,
	type JudgmentBatchRow,
	type JudgmentOperation,
	validateJudgmentOperation,
	validateJudgmentResult,
	validateJudgmentItem,
} from "../judgments-protocol";
import { SessionControlError } from "./session-control-service";

const clean = (text: string, max: number) => sanitizeText(text).replaceAll("\0", "").slice(0, max);
function row(status: JudgmentBatchStatus): JudgmentBatchRow {
	return {
		...status,
		intent: clean(status.intent, 512) || "Judging",
		...(status.error ? { error: clean(status.error, 4000) || "Judgment failed" } : {}),
		...(status.model ? { model: clean(status.model, 512) } : {}),
	};
}
/** Every mutation is fenced to the active session, and paid work is initiated only by create/retry. */
export class StudioJudgmentService {
	constructor(readonly session: AgentSession) {}
	async execute(operation: JudgmentOperation): Promise<unknown> {
		validateJudgmentOperation(operation);
		const native = this.session.studioToolSession;
		if (
			!native ||
			operation.sessionId !== this.session.sessionId ||
			operation.sessionId !== native.getSessionId?.()
		) {
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Batch judgments require the active session; refresh before trying again",
			);
		}
		const result = await this.#execute(operation, native);
		validateJudgmentResult(operation.kind, result);
		return result;
	}
	async #execute(
		operation: JudgmentOperation,
		native: NonNullable<AgentSession["studioToolSession"]>,
	): Promise<unknown> {
		if (operation.kind === "judgments.list") {
			const all = listJudgmentBatches(native).sort((a, b) => a.id.localeCompare(b.id));
			const start = operation.cursor ? all.findIndex(batch => batch.id > operation.cursor!) : 0;
			const page = start < 0 ? [] : all.slice(start, start + (operation.limit ?? 50));
			return {
				batches: page.map(batch => row(batch.status())),
				...(start >= 0 && start + page.length < all.length && page.length
					? { nextCursor: page[page.length - 1]!.id }
					: {}),
			};
		}
		if (operation.kind === "judgments.create" || operation.kind === "judgments.retry") {
			// Keep retained and running native jobs bounded. Closing releases input/result memory.
			if (listJudgmentBatches(native).length >= 64)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Close an old judgment batch before starting another (limit 64)",
				);
			if (operation.kind === "judgments.create") {
				const result = (await runEvalJudgmentBatch(
					{ op: "create", ...structuredClone(operation.spec) },
					{ session: native },
				)) as JudgmentBatchStatus;
				return { batch: row(result) };
			}
		}
		const batch = getJudgmentBatch(operation.id, native);
		if (!batch || batch.sessionId !== operation.sessionId)
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"This batch is closed, belongs to another session, or was lost when Runtime restarted",
			);
		if (operation.kind === "judgments.read") {
			const offset = operation.offset ?? 0;
			const items: JudgmentBatchItem[] = [];
			let size = 0;
			for (const original of batch.readItems(offset, operation.limit ?? 50)) {
				let item: JudgmentBatchItem;
				try {
					const candidate = {
						...original,
						...(original.error ? { error: clean(original.error, 4000) || "Judgment failed" } : {}),
					};
					validateJudgmentItem(candidate);
					item = candidate;
					if (Buffer.byteLength(JSON.stringify(item)) > 200000) throw new Error("Oversized item");
				} catch {
					// A native agent-created batch may have a shape too large for a GUI control frame.
					item = {
						key: `native-item-${offset + items.length}`,
						error: "This native result exceeds the Studio display limits. Read it through the original eval batch.",
					};
				}
				const length = Buffer.byteLength(JSON.stringify(item));
				if (items.length && size + length > 400000) break;
				items.push(item);
				size += length;
			}
			return { batch: row(batch.status()), items, offset, nextOffset: offset + items.length };
		}
		if (operation.kind === "judgments.retry")
			return { batch: row(retryJudgmentBatch(batch.id, native)), sourceId: batch.id };
		if (operation.kind === "judgments.cancel") return { cancelled: batch.cancel(), batch: row(batch.status()) };
		return runEvalJudgmentBatch({ op: "close", id: batch.id }, { session: native });
	}
}
