import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../src/session/agent-session";
import { StudioAnnotationService } from "../src/studio/services/annotation-service";
import type { AnnotationSource } from "../src/studio/annotations-protocol";

it("fences edited files while preserving operator-approved snapshot feedback", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-annotations-"));
	try {
		await writeFile(join(directory, "source.txt"), "first\noriginal\n");
		const service = new StudioAnnotationService({
			sessionId: "s",
			sessionManager: { getCwd: () => directory },
		} as unknown as AgentSession);
		const result = (await service.execute({
			kind: "annotations.capture",
			source: { kind: "file", path: "source.txt" },
		})) as { source: AnnotationSource };
		const input = {
			kind: "annotations.prepare" as const,
			sources: [result.source],
			notes: [
				{
					id: "note",
					sourceId: result.source.id,
					note: "Change this exact value",
					selection: { start: 6, end: 14 },
				},
			],
			action: "feedback" as const,
		};
		await writeFile(join(directory, "source.txt"), "first\nchanged\n");
		const stale = (await service.execute(input)) as { prompt: string; staleSources: string[] };
		expect(stale.prompt).toBe("");
		expect(stale.staleSources).toEqual([result.source.id]);
		const accepted = (await service.execute({ ...input, allowStale: true })) as { prompt: string };
		expect(accepted.prompt).toContain("original");
		expect(accepted.prompt).toContain("Change this exact value");
		const rejected = await service
			.execute({ kind: "annotations.capture", source: { kind: "file", path: "../private" } })
			.catch(error => error);
		expect(rejected).toBeInstanceOf(Error);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("rejects a session switch during multi-source preparation, including explicit stale approval", async () => {
	const session = { sessionId: "before", sessionManager: { getCwd: () => "." } };
	const service = new StudioAnnotationService(session as unknown as AgentSession);
	const { source } = (await service.execute({
		kind: "annotations.capture",
		source: { kind: "quote", text: "snapshot", label: "Source" },
	})) as { source: AnnotationSource };
	const file = { ...source, kind: "file" as const, path: "source.txt" };
	service.capture = async () => {
		session.sessionId = "after";
		return file;
	};
	const error = await service
		.execute({
			kind: "annotations.prepare",
			sources: [file],
			notes: [{ id: "note", sourceId: source.id, note: "Check" }],
			action: "feedback",
			allowStale: true,
		})
		.catch(error => error);
	expect(error).toMatchObject({ code: "COMMAND_BLOCKED" });
});

it("keeps long message snapshots and exact fences without calling a summarization model", async () => {
	const service = new StudioAnnotationService({
		sessionId: "s",
		sessionManager: { getCwd: () => "." },
	} as unknown as AgentSession);
	const text = "Long reply\n" + "context ".repeat(300) + "\n```quoted```\n";
	const { source } = (await service.execute({
		kind: "annotations.capture",
		source: { kind: "message", text, label: "Reply" },
	})) as { source: AnnotationSource };
	const result = (await service.execute({
		kind: "annotations.prepare",
		sources: [source],
		notes: [{ id: "note", sourceId: source.id, note: "Check all of this" }],
		action: "feedback",
	})) as { prompt: string };
	expect(result.prompt).toContain(text);
	expect(result.prompt).toContain("Check all of this");
});
