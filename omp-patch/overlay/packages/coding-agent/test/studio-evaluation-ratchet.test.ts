import { afterEach, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { IsoBackendKind } from "@oh-my-pi/pi-natives";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import * as worktree from "../src/task/worktree";
import * as structured from "../src/task/structured-subagent";
import type { StructuredSubagentResult } from "../src/task/structured-subagent";
import { createRatchetPrelude } from "../src/ratchet/prelude-definition";
import { EvaluationRatchetRunner } from "../src/studio/services/evaluation-ratchet-runner";
import type { RatchetEvaluationSpec } from "../src/studio/evaluation-workspace-protocol";
import { enforceStudioRatchetBoundary, installStudioRatchetBoundary } from "../src/studio/services/ratchet-boundary";

afterEach(() => vi.restoreAllMocks());
it("assisted preparation cannot run or gate a variant before the user starts evaluation", async () => {
	const cwd = path.join(os.tmpdir(), randomUUID());
	const release = installStudioRatchetBoundary(cwd, "prepare", 8, () => false, undefined, true);
	try {
		await expect(enforceStudioRatchetBoundary(cwd, { flow: "prepare", action: "check" })).rejects.toThrow(
			"Start the approved evaluation",
		);
		await expect(enforceStudioRatchetBoundary(cwd, { flow: "prepare", action: "gate" })).rejects.toThrow(
			"Start the approved evaluation",
		);
	} finally {
		release();
	}
});
it("exports the native gate's best change even when later work is rejected, and excludes evaluation material", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "evaluation-ratchet-")),
		source = path.join(root, "source"),
		isolated = path.join(root, "isolation", "m");
	const cases = ["a", "b", "c", "d", "e", "f", "g", "h"];
	await fs.mkdir(source, { recursive: true });
	await Bun.write(path.join(source, "cases.jsonl"), cases.map(id => JSON.stringify({ id })).join("\n"));
	await Bun.write(path.join(source, "runner.ts"), "// runner");
	await Bun.write(path.join(source, "prompt.md"), "user draft");
	spyOn(worktree, "ensureIsolation").mockImplementation(async () => {
		await fs.mkdir(path.dirname(isolated), { recursive: true });
		await fs.cp(source, isolated, { recursive: true });
		return { mergedDir: isolated, backend: IsoBackendKind.Rcopy, fellBack: false, fallbackReason: null };
	});
	spyOn(worktree, "captureIsolationBaseline").mockResolvedValue({
		root: {
			repoRoot: source,
			headCommit: "a".repeat(40),
			staged: "",
			unstaged: "user draft",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	});
	spyOn(worktree, "captureDeltaPatch").mockImplementation(async () => ({
		rootPatch: `diff --git a/prompt.md b/prompt.md\n--- a/prompt.md\n+++ b/prompt.md\n@@ -1 +1 @@\n-user draft\n+${await fs.readFile(path.join(isolated, "prompt.md"), "utf8")}\ndiff --git a/cases.jsonl b/cases.jsonl\n--- a/cases.jsonl\n+++ b/cases.jsonl\n@@ -1 +1 @@\n-old\n+evaluation evidence\n`,
		nestedPatches: [],
	}));
	const tools = {
		cwd: source,
		hasUI: true,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getToolContext: () => ({ hasUI: true, ui: { select: async () => "Approve" } }) as unknown as AgentToolContext,
	} as ToolSession;
	const session = {
		sessionId: "evaluation",
		studioToolSession: tools,
		sessionManager: { getCwd: () => source },
	} as unknown as AgentSession;
	const spec: RatchetEvaluationSpec = {
		kind: "ratchet",
		flow: "router",
		objective: "Improve routing",
		cases: ["cases.jsonl"],
		harness: ["runner.ts"],
		change: ["prompt.md"],
		offLimits: [],
		command: "bun runner.ts",
		cohorts: Object.fromEntries(cases.map(id => [id, "billing"])),
		metric: "quality",
		direction: "higher",
		reps: 1,
		roundsLimit: 8,
		seed: 7,
	};
	spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
		const prelude = createRatchetPrelude(request.session);
		for (const [variant, score, content] of [
			["baseline", 0.2, "user draft"],
			["v1", 0.8, "accepted improvement"],
			["v2", 0.1, "rejected experiment"],
		] as const) {
			await Bun.write(path.join(isolated, "prompt.md"), content);
			await Bun.write(
				path.join(isolated, ".omp", "ratchet", "router", variant, "results.jsonl"),
				cases.map(prompt_id => JSON.stringify({ prompt_id, rep: 0, grade: { quality: score } })).join("\n"),
			);
			await prelude.invoke(
				{ action: "gate", flow: "router", variant, change: content },
				{ session: request.session, toolCallId: randomUUID(), context: tools.getToolContext?.() },
			);
		}
		return { result: { id: "agent", exitCode: 0 } } as StructuredSubagentResult;
	});
	try {
		const runner = await EvaluationRatchetRunner.create(session, randomUUID(), spec, () => {});
		await runner.prepare();
		for (const stage of ["inputs", "grader", "plan"] as const) await runner.approve(stage);
		await runner.run(false);
		const report = await runner.read();
		expect(report.detail.bestPatchVariant).toBe("v1");
		const patch = await runner.patch();
		expect(patch).toContain("+accepted improvement");
		expect(patch).not.toContain("rejected experiment");
		expect(patch).not.toContain("cases.jsonl");
		expect(await fs.readFile(path.join(source, "prompt.md"), "utf8")).toBe("user draft");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
