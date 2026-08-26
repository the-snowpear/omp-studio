import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../session/agent-session";
import type { SessionTreeNode } from "../../session/session-entries";
import type { AskToolDetails, AskToolInput, QuestionResult } from "../../tools/ask";
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
			...(result.editorText === undefined ? {} : { editorText: result.editorText }),
			...(editorImages.length === 0 ? {} : { editorImages }),
		};
	}

	async branch(_commandId: string, input: { targetId: string }): Promise<unknown> {
		if (this.session.isStreaming) throw new StudioTreeError("BUSY_STREAMING", "Runtime is streaming");
		if (this.session.isCompacting) throw new StudioTreeError("BUSY_COMPACTING", "Runtime is compacting");
		const result = await this.session.branch(input.targetId);
		const editorImages = editorImagesFrom(result.selectedImages);
		return {
			cancelled: result.cancelled,
			sessionId: this.session.sessionManager.getSessionId(),
			editorText: result.selectedText,
			...(editorImages.length === 0 ? {} : { editorImages }),
		};
	}

	async #reanswerAsk(
		commandId: string,
		questions: AskToolInput["questions"],
	): Promise<AgentToolResult<AskToolDetails> | undefined> {
		const results: QuestionResult[] = [];
		for (const question of questions) {
			const answer = await this.#answerQuestion(commandId, question, questions.length > 1);
			if (answer === undefined) return undefined;
			results.push(answer);
		}
		if (results.length === 1) {
			const answer = results[0]!;
			const details: AskToolDetails = {
				question: answer.question,
				options: answer.options,
				multi: answer.multi,
				selectedOptions: answer.selectedOptions,
				...(answer.customInput === undefined ? {} : { customInput: answer.customInput }),
			};
			return { content: [{ type: "text", text: formatSingleAnswer(answer) }], details };
		}
		return {
			content: [{ type: "text", text: `User answers:\n${results.map(formatQuestionAnswer).join("\n")}` }],
			details: { results },
		};
	}

	async #answerQuestion(
		commandId: string,
		question: AskToolInput["questions"][number],
		allowEmpty: boolean,
	): Promise<QuestionResult | undefined> {
		const options = question.options.map((option, index) => ({
			id: `option:${index}`,
			label: option.label,
			...(option.description === undefined ? {} : { description: option.description }),
		}));
		const customId = "custom-input";
		let selectedIds: string[] = [];
		if (options.length > 0) {
			const selected = await this.interaction!.select({
				commandId,
				title: question.question,
				options: [...options, { id: customId, label: "Other (type your own)" }],
				multiple: question.multi === true,
			});
			if (selected === undefined) return undefined;
			selectedIds = typeof selected === "string" ? [selected] : selected;
			if (!question.multi && selectedIds.length !== 1) {
				throw new StudioTreeError("INVALID_ARGUMENT", "Ask interaction returned multiple single-choice answers");
			}
			if (selectedIds.some(id => id !== customId && !options.some(option => option.id === id))) {
				throw new StudioTreeError("INVALID_ARGUMENT", "Ask interaction returned an unknown option");
			}
		}
		let customInput: string | undefined;
		if (options.length === 0 || selectedIds.includes(customId)) {
			customInput = await this.interaction!.input({
				commandId,
				title: question.question,
				placeholder: "Type your answer",
			});
			if (customInput === undefined) return undefined;
		}
		const selectedOptions = selectedIds
			.filter(id => id !== customId)
			.map(id => options.find(option => option.id === id)!.label);
		if (!allowEmpty && selectedOptions.length === 0 && customInput === undefined) return undefined;
		return {
			id: question.id,
			question: question.question,
			options: options.map(option => option.label),
			multi: question.multi ?? false,
			selectedOptions,
			...(customInput === undefined ? {} : { customInput }),
		};
	}
}

function formatQuestionAnswer(result: QuestionResult): string {
	if (result.customInput !== undefined) return `${result.id}: "${result.customInput}"`;
	if (result.multi) return `${result.id}: [${result.selectedOptions.join(", ")}]`;
	return `${result.id}: ${result.selectedOptions[0] ?? "(cancelled)"}`;
}

function formatSingleAnswer(result: QuestionResult): string {
	const parts: string[] = [];
	if (result.selectedOptions.length > 0) {
		parts.push(
			result.multi
				? `User selected: ${result.selectedOptions.join(", ")}`
				: `User selected: ${result.selectedOptions[0]}`,
		);
	}
	if (result.customInput !== undefined) parts.push(`User provided custom input: ${result.customInput}`);
	return parts.join("\n");
}
