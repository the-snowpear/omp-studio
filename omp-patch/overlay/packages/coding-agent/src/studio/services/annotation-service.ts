import { createHash, randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import { buildTextReviewPrompt } from "../../extensibility/custom-commands/bundled/annotate/text-review";
import { buildReviewPrompt } from "../../extensibility/custom-commands/bundled/review/prompt";
import {
	createResolvedReviewTarget,
	readUncommittedReviewTarget,
} from "../../extensibility/custom-commands/bundled/review/target";
import type { TextReviewAnnotation } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import {
	type AnnotationCapture,
	type AnnotationSource,
	type AnnotationOperation,
	validateAnnotationOperation,
	validateAnnotationResult,
} from "../annotations-protocol";
import { SessionControlError } from "./session-control-service";

export const annotationVersion = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const normalize = (text: string) => text.replace(/\r\n?/gu, "\n");

/** Native prompt builders over versioned snapshots; never sends a model request. */
export class StudioAnnotationService {
	constructor(readonly session: AgentSession) {}
	async execute(operation: AnnotationOperation): Promise<unknown> {
		validateAnnotationOperation(operation);
		try {
			const result =
				operation.kind === "annotations.capture"
					? { source: await this.capture(operation.source) }
					: await this.prepare(operation);
			validateAnnotationResult(operation.kind, result);
			return result;
		} catch (error) {
			if (error instanceof SessionControlError) throw error;
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"Unable to prepare annotations. Check the source, its size, and its text encoding.",
			);
		}
	}
	async capture(input: AnnotationCapture): Promise<AnnotationSource> {
		const capturedCwd = this.session.sessionManager.getCwd();
		const capturedSessionId = this.session.sessionId;
		let text: string;
		let label: string;
		if (input.kind === "file") {
			const root = await realpath(capturedCwd);
			const file = await realpath(path.resolve(root, input.path));
			const relative = path.relative(root, file);
			if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
				throw new SessionControlError("INVALID_ARGUMENT", "Annotation file must stay inside the workspace");
			const handle = await open(file, "r");
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > 360000)
					throw new SessionControlError("INVALID_ARGUMENT", "Annotation file must be a small text file");
				const bytes = Buffer.alloc(stat.size + 1);
				let offset = 0;
				while (offset < bytes.length) {
					const read = await handle.read(bytes, offset, bytes.length - offset, offset);
					if (!read.bytesRead) break;
					offset += read.bytesRead;
				}
				if (offset !== stat.size)
					throw new SessionControlError("INVALID_ARGUMENT", "File changed during capture; try again");
				text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
			} finally {
				await handle.close();
			}
			label = input.path;
		} else if (input.kind === "diff") {
			const target = await readUncommittedReviewTarget(capturedCwd);
			const relative = input.path?.replaceAll("\\", "/");
			text = target.snapshot.files
				.filter(
					file => !relative || file.path === relative || file.newPath === relative || file.oldPath === relative,
				)
				.map(file => file.rawDiff)
				.join("\n");
			if (!text.trim()) throw new SessionControlError("INVALID_ARGUMENT", "No reviewable changes for this source");
			label = input.path ?? "Uncommitted changes";
		} else {
			text = input.text;
			label = input.label;
		}
		text = normalize(text);
		if (text.length > 120000 || text.includes("\0"))
			throw new SessionControlError("INVALID_ARGUMENT", "Annotation source is too large or binary");
		const reference =
			input.kind === "file" || input.kind === "diff"
				? capturedCwd + ":" + input.kind + ":" + (input.path ?? "*")
				: randomUUID();
		if (this.session.sessionId !== capturedSessionId || this.session.sessionManager.getCwd() !== capturedCwd)
			throw new SessionControlError("COMMAND_BLOCKED", "Session changed during source capture; try again");
		return {
			id: "source-" + createHash("sha256").update(reference).digest("hex").slice(0, 32),
			kind: input.kind,
			label,
			text,
			version: annotationVersion(text),
			...("path" in input && input.path ? { path: input.path } : {}),
			sessionId: "sessionId" in input && input.sessionId ? input.sessionId : capturedSessionId,
			...("messageId" in input && input.messageId ? { messageId: input.messageId } : {}),
		};
	}
	async prepare(
		operation: Extract<AnnotationOperation, { kind: "annotations.prepare" }>,
	): Promise<{ prompt: string; staleSources: string[] }> {
		const capturedCwd = this.session.sessionManager.getCwd();
		const capturedSessionId = this.session.sessionId;
		const staleSources: string[] = [];
		const prompts: string[] = [];
		for (const source of operation.sources) {
			if (source.version !== annotationVersion(source.text))
				throw new SessionControlError("INVALID_ARGUMENT", "Annotation source contents do not match their version");
			const notes = operation.notes.filter(note => note.sourceId === source.id);
			if (!notes.length) continue;
			if (source.kind === "file" || source.kind === "diff") {
				try {
					const current = await this.capture(
						source.kind === "file"
							? { kind: "file", path: source.path! }
							: { kind: "diff", ...(source.path ? { path: source.path } : {}) },
					);
					if (
						current.version !== source.version ||
						(source.id !== current.id && !source.id.startsWith(current.id + ":"))
					)
						staleSources.push(source.id);
				} catch {
					staleSources.push(source.id);
				}
			} else if (source.sessionId && source.sessionId !== this.session.sessionId) staleSources.push(source.id);
			const native: TextReviewAnnotation[] = notes.map(note =>
				note.selection
					? {
							scope: "line",
							line: source.text.slice(0, note.selection.start).split("\n").length,
							quote: source.text.slice(note.selection.start, note.selection.end),
							note: note.note,
						}
					: { scope: "text", note: note.note },
			);
			const feedback =
				buildTextReviewPrompt(
					{
						id: source.id,
						kind: source.kind === "diff" ? "code" : source.kind === "quote" ? "prompt" : source.kind,
						...(source.kind === "message"
							? { provenance: { kind: "session" as const, entryId: source.messageId ?? source.id } }
							: {}),
						label: source.label + " (" + source.version + ")",
						text: source.text,
					},
					native,
				) ?? "";
			prompts.push(
				operation.action === "review" && source.kind === "diff"
					? buildReviewPrompt(
							createResolvedReviewTarget("uncommitted", "Studio annotated snapshot", source.text, "No changes", {
								contextInstruction:
									"The operator annotated the captured source version. Check for drift before applying changes.",
							}),
							feedback,
						)
					: feedback,
			);
		}
		if (this.session.sessionId !== capturedSessionId || this.session.sessionManager.getCwd() !== capturedCwd)
			throw new SessionControlError("COMMAND_BLOCKED", "Session changed while preparing annotations; try again");
		return {
			prompt: staleSources.length && !operation.allowStale ? "" : prompts.filter(Boolean).join("\n\n---\n\n"),
			staleSources,
		};
	}
}
