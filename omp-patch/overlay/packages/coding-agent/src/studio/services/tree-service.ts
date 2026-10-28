import type { ImageContent } from "@oh-my-pi/pi-ai";
import { shiftImageMarkers } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { renderAttachmentSourceNotice } from "../../session/attachment-source-notice";
import { expandModelMentionTags, type ModelMention } from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../session/agent-session";
import type { SessionTreeNode } from "../../session/session-entries";
import { formatQuestionResult, formatSingleQuestionResponse, type AskToolInput } from "../../tools/ask";
import { mapAskDialogValue } from "../remote-extension-ui";
import type { AskToolDetails, QuestionResult } from "@oh-my-pi/pi-tui/tools/ask";
import type { StudioInteractionPort } from "./interaction-port";

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
		readonly code: "INTERACTION_REQUIRED" | "INVALID_ARGUMENT" | "BUSY_STREAMING" | "BUSY_COMPACTING",
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
	constructor(
		private readonly session: AgentSession,
		private readonly interaction?: StudioInteractionPort,
	) {}

	#restoreModelTags(text: string, previous: readonly ModelMention[]): string {
		const selectors = new Map(
			[...previous, ...(this.session.modelMentions ?? [])].map(mention => [mention.agent, mention.selector]),
		);
		return expandModelMentionTags(text, agent => selectors.get(agent));
	}

	getTree(): { leafId: string | null; roots: StudioTreeNode[] } {
		return {
			leafId: this.session.sessionManager.getLeafId(),
			roots: this.session.sessionManager.getTree().map(projectNode),
		};
	}

	async navigate(
		commandId: string,
		input: { targetId: string; summarize?: boolean; customInstructions?: string },
	): Promise<unknown> {
		if (this.session.isStreaming) throw new StudioTreeError("BUSY_STREAMING", "Runtime is streaming");
		if (this.session.isCompacting) throw new StudioTreeError("BUSY_COMPACTING", "Runtime is compacting");
		const mentions = [...(this.session.modelMentions ?? [])];
		let result = await this.session.navigateTree(input.targetId, {
			summarize: input.summarize,
			customInstructions: input.customInstructions,
			allowAskReopen: true,
		});
		if (result.reopenAsk !== undefined) {
			if (this.interaction === undefined) {
				throw new StudioTreeError("INTERACTION_REQUIRED", "Tree navigation requires an Ask response", {
					toolCallId: result.reopenAsk.toolCallId,
					questions: structuredClone(result.reopenAsk.questions),
				});
			}
			const reanswer = await this.#reanswerAsk(commandId, result.reopenAsk.questions);
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
				reanswerAskResult: reanswer,
			});
		}
		if (result.askReanswerCommitted) this.session.resumeAfterAskReanswer();
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

	async #reanswerAsk(
		commandId: string,
		questions: AskToolInput["questions"],
	): Promise<AgentToolResult<AskToolDetails> | undefined> {
		const payload = await this.interaction!.ask({
			commandId,
			title: "Re-answer",
			acceptImages: true,
			questions: questions.map(question => ({
				id: question.id,
				question: question.question,
				options: question.options.map((option, index) => ({ id: `option:${index}`, ...option })),
				multiple: question.multi === true,
			})),
		});
		if (payload === undefined) return undefined;
		const mapped = mapAskDialogValue(payload, questions, true);
		if (mapped.kind !== "submit") return undefined;
		const images: ImageContent[] = [];
		const results: QuestionResult[] = mapped.results.map(answer => {
			const customOffset = images.length;
			images.push(...(answer.customInputImages ?? []));
			const noteOffset = images.length;
			images.push(...(answer.noteImages ?? []));
			return {
				id: answer.id,
				question: answer.question,
				options: answer.options,
				multi: answer.multi,
				selectedOptions: answer.selectedOptions,
				...(answer.customInput === undefined
					? {}
					: {
							customInput: shiftImageMarkers(
								answer.customInput,
								customOffset,
								answer.customInputImages?.length ?? 0,
							),
						}),
				...(answer.note === undefined
					? {}
					: { note: shiftImageMarkers(answer.note, noteOffset, answer.noteImages?.length ?? 0) }),
				...(answer.noteOption === undefined ? {} : { noteOption: answer.noteOption }),
			};
		});
		if (
			results.length === 1 &&
			!results[0]!.multi &&
			!results[0]!.selectedOptions.length &&
			results[0]!.customInput === undefined &&
			!images.length
		)
			return undefined;
		const imageBlocks: AgentToolResult<AskToolDetails>["content"] = images.flatMap((image, index) => {
			const notice = renderAttachmentSourceNotice(image, index + 1, { askAnswer: true });
			return notice ? [{ type: "text" as const, text: notice.content }, image] : [image];
		});
		if (results.length === 1) {
			const answer = results[0]!;
			const details: AskToolDetails = {
				question: answer.question,
				options: answer.options,
				multi: answer.multi,
				selectedOptions: answer.selectedOptions,
				...(answer.customInput === undefined ? {} : { customInput: answer.customInput }),
				...(answer.note ? { note: answer.note } : {}),
				...(answer.noteOption ? { noteOption: answer.noteOption } : {}),
			};
			return { content: [{ type: "text", text: formatSingleQuestionResponse(answer) }, ...imageBlocks], details };
		}
		return {
			content: [
				{ type: "text", text: `User answers:\n${results.map(formatQuestionResult).join("\n")}` },
				...imageBlocks,
			],
			details: { results },
		};
	}
}
