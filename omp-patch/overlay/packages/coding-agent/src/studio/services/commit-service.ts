import { ChangeJournal } from "../../commit/selective/journal";
import {
	commitDraftStoreFor,
	type DraftContext,
	draftFor,
	type StoredCommitDraft,
} from "../../commit/selective/prelude-definition";
import type { Settings } from "../../config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { parseCommitArgs } from "../../slash-commands/builtin-commit";
import { cfgCommitEnabled } from "../../tools/settings";
import type {
	SelectiveCommitDraft,
	SelectiveCommitOperation,
	SelectiveCommitRead,
	SelectiveCommitResultMap,
} from "../commit-protocol";
import { SessionControlError } from "./session-control-service";

const BODY_PAGE_CHARS = 24_000;

/** AgentSession satisfies this surface. No second session or executor is constructed. */
export interface CommitServiceSession {
	readonly sessionId: string;
	readonly transcriptEpoch: number;
	readonly settings: Settings;
	readonly sessionManager: { getCwd(): string; getArtifactsDir(): string | null };
	getAgentId(): string | undefined;
}
interface Binding {
	context: DraftContext;
	runtimeEpoch: number;
	transcriptEpoch: number;
}

/** Thin typed adapter over the same native draft store/actions used by eval and /commit. */
export class StudioCommitService {
	#binding: Binding;
	#lifetime = new AbortController();
	#disposed = false;
	constructor(
		readonly session: CommitServiceSession,
		readonly runtimeEpoch: () => number,
	) {
		this.#binding = this.#capture();
	}

	#capture(): Binding {
		return {
			context: {
				cwd: this.session.sessionManager.getCwd(),
				artifactsDir: this.session.sessionManager.getArtifactsDir(),
				agent: this.session.getAgentId() ?? MAIN_AGENT_ID,
				sessionId: this.session.sessionId,
			},
			runtimeEpoch: this.runtimeEpoch(),
			transcriptEpoch: this.session.transcriptEpoch,
		};
	}

	#same(left: Binding, right: Binding): boolean {
		return (
			left.runtimeEpoch === right.runtimeEpoch &&
			left.transcriptEpoch === right.transcriptEpoch &&
			left.context.sessionId === right.context.sessionId &&
			left.context.agent === right.context.agent &&
			left.context.artifactsDir === right.context.artifactsDir &&
			left.context.cwd === right.context.cwd
		);
	}

	#synchronize(): void {
		const current = this.#capture();
		if (this.#same(current, this.#binding)) return;
		commitDraftStoreFor(this.#binding.context).clear();
		this.#lifetime.abort(new Error("Selective commit session binding changed."));
		this.#lifetime = new AbortController();
		this.#binding = current;
	}

	dispose(): void {
		this.#disposed = true;
		this.#lifetime.abort(new Error("Selective commit service disposed."));
		commitDraftStoreFor(this.#binding.context).clear();
	}

	#assertCurrent(binding: Binding): void {
		this.#synchronize();
		if (this.#disposed || binding !== this.#binding) {
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Commit draft belongs to an earlier session or Runtime",
				true,
			);
		}
	}

	#describe(entry: StoredCommitDraft, binding: Binding): SelectiveCommitDraft {
		return {
			sessionId: binding.context.sessionId!,
			runtimeEpoch: binding.runtimeEpoch,
			expiresAt: entry.expiresAt,
			view: entry.draft.view(),
		};
	}

	/** Studio /commit opens a draft; opaque native instructions never become flags or a model request. */
	async prepareFromArgs(
		args: string,
		signal?: AbortSignal,
	): Promise<{ draft: SelectiveCommitDraft; instructions: string }> {
		const { instructions } = parseCommitArgs(args);
		const draft = await this.execute({ kind: "commit.draft.prepare", sessionId: this.session.sessionId }, signal);
		return { draft, instructions };
	}

	/** validateSelectiveCommitOperation runs once at the Runtime protocol boundary, not again here. */
	async execute<K extends SelectiveCommitOperation["kind"]>(
		input: Extract<SelectiveCommitOperation, { kind: K }>,
		signal?: AbortSignal,
	): Promise<SelectiveCommitResultMap[K]> {
		const operation = input as SelectiveCommitOperation;
		this.#synchronize();
		const binding = this.#binding;
		this.#assertCurrent(binding);
		if (operation.sessionId !== binding.context.sessionId) {
			throw new SessionControlError("COMMAND_BLOCKED", "Selective commit requires the current native session");
		}
		if (operation.kind !== "commit.draft.release" && cfgCommitEnabled.get(this.session.settings) !== true) {
			throw new SessionControlError("CAPABILITY_UNAVAILABLE", "Selective commit is disabled by commit.enabled");
		}
		const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
		const store = commitDraftStoreFor(binding.context);
		try {
			combined.throwIfAborted();
			switch (operation.kind) {
				case "commit.draft.prepare": {
					const draft = await draftFor({ ...binding.context, signal: combined }, operation.scope);
					try {
						this.#assertCurrent(binding);
						combined.throwIfAborted();
					} catch (error) {
						commitDraftStoreFor(binding.context).release(draft.id);
						throw error;
					}
					return this.#describe(
						commitDraftStoreFor(binding.context).get(draft.id),
						binding,
					) as SelectiveCommitResultMap[K];
				}
				case "commit.draft.release":
					return { released: store.release(operation.draftId) } as SelectiveCommitResultMap[K];
				case "commit.draft.read": {
					const entry = store.get(operation.draftId, operation.revision);
					const result: SelectiveCommitRead = { draft: this.#describe(entry, binding) };
					if (operation.body) {
						const target = operation.body;
						const text =
							target.kind === "file"
								? entry.draft.fileDiff(target.path)
								: store.prepared(operation.draftId, operation.revision, target.previewId).patch;
						const offset = target.offset ?? 0;
						const totalChars = text?.length ?? 0;
						let end = Math.min(totalChars, offset + BODY_PAGE_CHARS);
						if (text && end < totalChars && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
						result.body = {
							kind: target.kind,
							text: text === null ? null : text.slice(offset, end),
							offset,
							totalChars,
							...(end < totalChars ? { nextOffset: end } : {}),
						};
					}
					return result as SelectiveCommitResultMap[K];
				}
				case "commit.draft.select": {
					const selection = operation.selection;
					const { entry } = store.select(
						operation.draftId,
						selection.action === "only"
							? { action: "only", globs: selection.paths }
							: { action: selection.action, target: { path: selection.path, units: selection.units } },
						operation.revision,
					);
					return this.#describe(entry, binding) as SelectiveCommitResultMap[K];
				}
				case "commit.draft.preview": {
					const prepared = await store.preview(operation.draftId, operation.revision, combined);
					this.#assertCurrent(binding);
					return {
						draftId: prepared.draftId,
						revision: prepared.revision,
						previewId: prepared.id,
						head: prepared.head,
						tree: prepared.tree,
						bytes: prepared.bytes,
						paths: prepared.patches.map(entry => entry.path),
						expiresAt: store.get(prepared.draftId).expiresAt,
					} as SelectiveCommitResultMap[K];
				}
				case "commit.draft.execute": {
					const { artifactsDir, agent } = binding.context;
					const result = await store.commit(
						operation.draftId,
						{
							subject: operation.message.subject,
							body: operation.message.body,
							fixes: operation.message.fixes,
							amend: operation.options?.amend,
							noVerify: operation.options?.noVerify,
						},
						{
							journal: artifactsDir ? ChangeJournal.at(artifactsDir) : null,
							agent: { agent, parent: AgentRegistry.global().get(agent)?.parentId },
							signal: combined,
							assertCurrent: () => this.#assertCurrent(binding),
						},
						{ revision: operation.revision, previewId: operation.previewId },
					);
					return result as SelectiveCommitResultMap[K];
				}
			}
			throw new SessionControlError("INVALID_ARGUMENT", "Unknown selective commit operation");
		} catch (error) {
			if (error instanceof SessionControlError) throw error;
			throw new SessionControlError("COMMAND_BLOCKED", error instanceof Error ? error.message : String(error), true);
		}
	}
}
