import { expandModelMentionTags, type ModelMention } from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../session/agent-session";
import type { SessionTreeNode } from "../../session/session-entries";
import { createAskFormResult, recoverAskHtml } from "../../tools/ask";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import type { StudioInteractionPort } from "./interaction-port";
import { presentHtmlForm } from "./form-presentation";
import { askTimeoutMs } from "../../modes/settings";

const EDITOR_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type StudioEditorImage = {
	type: "image";
	mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	data: string;
};

function editorImagesFrom(
	images: ReadonlyArray<{ type?: string; mimeType?: string; data?: string }> | undefined,
): StudioEditorImage[] {
	if (images === undefined || images.length === 0) return [];
	const out: StudioEditorImage[] = [];
	for (const image of images) {
		if (image.type !== "image") continue;
		if (typeof image.data !== "string" || image.data.length === 0) continue;
		if (!EDITOR_IMAGE_MIME.has(image.mimeType ?? "")) continue;
		out.push({
			type: "image",
			mimeType: image.mimeType as StudioEditorImage["mimeType"],
			data: image.data,
		});
	}
	return out;
}

export interface StudioTreeNode {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	label?: string;
	role?: string;
	toolName?: string;
	children: StudioTreeNode[];
}

export class StudioTreeError extends Error {
	constructor(
		readonly code:
			| "INTERACTION_REQUIRED"
			| "INTERACTION_STALE"
			| "INVALID_ARGUMENT"
			| "BUSY_STREAMING"
			| "BUSY_COMPACTING",
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "StudioTreeError";
	}
}

function projectNode(node: SessionTreeNode): StudioTreeNode {
	const entry = node.entry;
	const message = entry.type === "message" ? entry.message : undefined;
	return {
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type,
		timestamp: entry.timestamp,
		...(node.label === undefined ? {} : { label: node.label }),
		...(message === undefined ? {} : { role: message.role }),
		...(message?.role === "toolResult" ? { toolName: message.toolName } : {}),
		children: node.children.map(projectNode),
	};
}

export class StudioTreeService {
	#navigationGeneration = 0;
	#reanswerAbort: AbortController | undefined;

	constructor(
		private readonly session: AgentSession,
		private readonly interaction?: StudioInteractionPort,
	) {}

	/** A new navigation, operator abort or Runtime teardown must not commit a late re-answer. */
	cancelReanswer(reason = "Tree re-answer superseded"): void {
		this.#navigationGeneration++;
		this.#reanswerAbort?.abort(new DOMException(reason, "AbortError"));
		this.#reanswerAbort = undefined;
	}

	#restoreModelTags(text: string, previous: readonly ModelMention[]): string {
		const selectors = new Map(
			[...previous, ...(this.session.modelMentions ?? [])].map(mention => [mention.agent, mention.selector]),
		);
		return expandModelMentionTags(text, agent => selectors.get(agent));
	}

	getTree(): { leafId: string | null; roots: StudioTreeNode[]; supportsExactRestore: true } {
		return {
			supportsExactRestore: true,
			leafId: this.session.sessionManager.getLeafId(),
			roots: this.session.sessionManager.getTree().map(projectNode),
		};
	}

	async navigate(
		commandId: string,
		input: {
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			exactLeaf?: boolean;
			restoreRoot?: boolean;
		},
	): Promise<unknown> {
		if (this.session.isStreaming) throw new StudioTreeError("BUSY_STREAMING", "Runtime is streaming");
		if (this.session.isCompacting) throw new StudioTreeError("BUSY_COMPACTING", "Runtime is compacting");
		this.cancelReanswer();
		const generation = this.#navigationGeneration;
		const manager = this.session.sessionManager;
		const sessionId = this.session.sessionId;
		const leafId = manager.getLeafId();
		const mentions = [...(this.session.modelMentions ?? [])];
		const targetId = input.restoreRoot ? leafId : input.targetId;
		if (targetId === null) return { cancelled: false, leafId: null };
		if (!input.exactLeaf && !input.restoreRoot) this.#assertAskReanswerAvailable(targetId);
		let result = await this.session.navigateTree(targetId, {
			summarize: input.summarize,
			customInstructions: input.customInstructions,
			allowAskReopen: !input.exactLeaf && !input.restoreRoot,
			exactLeaf: input.exactLeaf,
			restoreRoot: input.restoreRoot,
			requireIdle: input.exactLeaf || input.restoreRoot,
		});
		if (result.reopenAsk !== undefined) {
			if (this.interaction === undefined) {
				throw new StudioTreeError("INTERACTION_REQUIRED", "Tree navigation requires an Ask response", {
					toolCallId: result.reopenAsk.toolCallId,
				});
			}
			const assertCurrent = () => {
				if (
					generation !== this.#navigationGeneration ||
					this.session.isDisposed ||
					this.session.sessionManager !== manager ||
					this.session.sessionId !== sessionId ||
					manager.getLeafId() !== leafId
				) {
					throw new StudioTreeError("INTERACTION_STALE", "这份重答已过期；当前会话或历史分支已改变，未写入答案。");
				}
				if (this.session.isStreaming)
					throw new StudioTreeError("BUSY_STREAMING", "Runtime started streaming before the re-answer committed");
				if (this.session.isCompacting)
					throw new StudioTreeError(
						"BUSY_COMPACTING",
						"Runtime started compacting before the re-answer committed",
					);
			};
			assertCurrent();
			const abort = new AbortController();
			this.#reanswerAbort = abort;
			let reanswer: AgentToolResult<AskToolDetails> | undefined;
			try {
				reanswer = await this.#reanswerAsk(commandId, result.reopenAsk.html, abort.signal, assertCurrent);
				assertCurrent();
			} finally {
				if (this.#reanswerAbort === abort) this.#reanswerAbort = undefined;
			}
			if (reanswer === undefined) {
				return {
					cancelled: true,
					aborted: false,
					askReanswerCommitted: false,
					leafId: this.session.sessionManager.getLeafId(),
				};
			}
			result = await this.session.navigateTree(input.targetId, {
				summarize: input.summarize,
				customInstructions: input.customInstructions,
				allowAskReopen: true,
				requireIdle: true,
				reanswerAskResult: reanswer,
			});
		}
		if (result.askReanswerCommitted) this.session.resumeAfterAskReanswer();
		if (!result.cancelled && (input.exactLeaf || input.restoreRoot)) {
			// A metadata child makes the chosen branch survive a restart without truncating history.
			this.session.sessionManager.appendCustomEntry("studio-time-travel", {
				targetId: this.session.sessionManager.getLeafId(),
			});
			await this.session.sessionManager.flush();
		}
		const editorImages = editorImagesFrom(result.editorImages);
		return {
			cancelled: result.cancelled,
			aborted: result.aborted === true,
			askReanswerCommitted: result.askReanswerCommitted === true,
			leafId: this.session.sessionManager.getLeafId(),
			...(result.editorText === undefined
				? {}
				: { editorText: this.#restoreModelTags(result.editorText, mentions) }),
			...(editorImages.length === 0 ? {} : { editorImages }),
		};
	}

	async branch(_commandId: string, input: { targetId: string }): Promise<unknown> {
		if (this.session.isStreaming) throw new StudioTreeError("BUSY_STREAMING", "Runtime is streaming");
		if (this.session.isCompacting) throw new StudioTreeError("BUSY_COMPACTING", "Runtime is compacting");
		this.cancelReanswer();
		const mentions = [...(this.session.modelMentions ?? [])];
		const result = await this.session.branch(input.targetId);
		const editorImages = editorImagesFrom(result.selectedImages);
		return {
			cancelled: result.cancelled,
			sessionId: this.session.sessionManager.getSessionId(),
			editorText: this.#restoreModelTags(result.selectedText, mentions),
			...(editorImages.length === 0 ? {} : { editorImages }),
		};
	}

	#assertAskReanswerAvailable(targetId: string): void {
		const manager = this.session.sessionManager;
		const target = manager.getEntry(targetId);
		if (target?.type !== "message" || target.message.role !== "toolResult" || target.message.toolName !== "ask")
			return;
		const toolCallId = target.message.toolCallId;
		let parentId = target.parentId;
		while (parentId) {
			const entry = manager.getEntry(parentId);
			if (!entry) return;
			if (entry.type === "message") {
				if (entry.message.role === "user") return;
				if (entry.message.role === "assistant") {
					const call = entry.message.content.find(block => block.type === "toolCall" && block.id === toolCallId);
					if (call?.type === "toolCall") {
						if (
							recoverAskHtml(call.arguments) === undefined &&
							isRecord(call.arguments) &&
							Array.isArray(call.arguments.questions)
						) {
							throw new StudioTreeError(
								"INVALID_ARGUMENT",
								"这条旧版 questions 提问仍可回看，但原生 HTML 表单无法重答；请发送一条新消息说明修改。",
								{ toolCallId },
							);
						}
						return;
					}
				}
			}
			parentId = entry.parentId;
		}
	}

	async #reanswerAsk(
		commandId: string,
		html: string,
		signal: AbortSignal,
		assertCurrent: () => void,
	): Promise<AgentToolResult<AskToolDetails> | undefined> {
		assertCurrent();
		signal.throwIfAborted();
		const form = parseHtmlForm(html);
		const timeoutMs = this.session.getPlanModeState?.()?.enabled ? undefined : askTimeoutMs(this.session.settings);
		const presentation = await presentHtmlForm(form, { cwd: this.session.sessionManager.getCwd(), signal });
		assertCurrent();
		signal.throwIfAborted();
		const answered = await this.interaction!.form({
			commandId,
			title: "Re-answer",
			form: presentation,
			signal,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		});
		return answered === undefined ? undefined : createAskFormResult(form, answered);
	}
}
