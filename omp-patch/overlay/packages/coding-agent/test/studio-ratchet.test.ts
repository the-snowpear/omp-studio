import { afterEach, expect, spyOn, test, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { getWorktreeDir } from "@oh-my-pi/pi-utils";
import { IsoBackendKind } from "@oh-my-pi/pi-natives";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import * as worktree from "../src/task/worktree";
import * as structured from "../src/task/structured-subagent";
import type { StructuredSubagentResult } from "../src/task/structured-subagent";
import { ISOLATION_OWNER_FILE } from "../src/task/isolation-ownership";
import { StudioRatchetService } from "../src/studio/services/ratchet-service";
import { enforceStudioRatchetBoundary } from "../src/studio/services/ratchet-boundary";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../src/studio/workbench-protocol";
import type { RatchetRunView } from "../src/studio/ratchet-protocol";

afterEach(() => mock.restore());
test("Ratchet uses isolated native state, invalidates changed approvals, and stops without reverting source or resending after recovery", async () => {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), "studio-ratchet-source-"));
	const base = getWorktreeDir("studio-ratchet-test-" + randomUUID());
	const isolated = path.join(base, "m");
	let duringReview: () => Promise<void> = async () => {};
	let runningSignal: AbortSignal | undefined;
	const tools = {
		cwd: source,
		hasUI: true,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getToolContext: () =>
			({
				hasUI: true,
				ui: {
					select: async () => {
						await duringReview();
						return "Approve";
					},
				},
			}) as unknown as AgentToolContext,
	} as ToolSession;
	const session = { sessionId: "ratchet-owner", studioToolSession: tools } as AgentSession;
	const service = new StudioRatchetService(session);
	const finished = Promise.withResolvers<StructuredSubagentResult>();
	const runner = spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
		runningSignal = request.signal;
		request.signal?.addEventListener(
			"abort",
			() => finished.resolve({ result: { id: "native-agent", exitCode: 0 } } as StructuredSubagentResult),
			{ once: true },
		);
		return finished.promise;
	});
	spyOn(worktree, "ensureIsolation").mockImplementation(async (cwd, id) => {
		await fs.mkdir(base, { recursive: true });
		await fs.cp(cwd, isolated, { recursive: true });
		await Bun.write(path.join(base, ISOLATION_OWNER_FILE), JSON.stringify({ id, pid: process.pid }));
		return { mergedDir: isolated, backend: IsoBackendKind.Rcopy, fellBack: false, fallbackReason: null };
	});
	try {
		await Bun.write(path.join(source, "cases.jsonl"), '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n{"id":"d"}\n');
		await Bun.write(path.join(source, "run.ts"), "runner");
		await Bun.write(path.join(source, "prompt.md"), "user uncommitted draft");
		const create = {
			kind: "ratchet.create" as const,
			sessionId: session.sessionId,
			flow: "router",
			cases: ["cases.jsonl"],
			harness: ["run.ts"],
			change: ["prompt.md"],
			offLimits: [],
			command: "bun run.ts --variant {variant}",
			cohorts: { a: "x", b: "x", c: "x", d: "x" },
			metric: "score",
			direction: "higher" as const,
			reps: 1,
			roundsLimit: 2,
			costLimit: 0.1,
		};
		validateWorkbenchOperation(create);
		const run = (await service.execute(create)) as RatchetRunView;
		validateWorkbenchResult("ratchet.create", run);
		expect(run.workspace).toBe(isolated);
		expect(run.trainCount + run.testCount).toBe(4);
		await expect(
			service.execute({ kind: "ratchet.start", sessionId: session.sessionId, id: run.id }),
		).rejects.toThrow("approvals");
		expect(runner).not.toHaveBeenCalled();
		duringReview = async () => {
			await Bun.write(path.join(isolated, "cases.jsonl"), '{"id":"a","updated":true}\n');
		};
		expect(
			await service.execute({ kind: "ratchet.approve", sessionId: session.sessionId, id: run.id, stage: "inputs" }),
		).toMatchObject({ approved: false });
		duringReview = async () => {};
		for (const stage of ["inputs", "grader", "plan"] as const)
			expect(
				await service.execute({ kind: "ratchet.approve", sessionId: session.sessionId, id: run.id, stage }),
			).toMatchObject({ approved: true });
		const started = (await service.execute({
			kind: "ratchet.start",
			sessionId: session.sessionId,
			id: run.id,
		})) as RatchetRunView;
		expect(started.state).toBe("running");
		expect(runner).toHaveBeenCalledTimes(1);
		expect(runner.mock.calls[0]![0].session.cwd).toBe(isolated);
		await expect(enforceStudioRatchetBoundary(isolated, { flow: "router", action: "plan" })).rejects.toThrow(
			"review",
		);
		const other = new StudioRatchetService(session);
		await expect(other.execute({ kind: "ratchet.start", sessionId: session.sessionId, id: run.id })).rejects.toThrow(
			"owns",
		);
		other.dispose();
		await Bun.write(path.join(isolated, "prompt.md"), "candidate evidence");
		await service.execute({ kind: "ratchet.stop", sessionId: session.sessionId, id: run.id });
		expect(runningSignal?.aborted).toBe(true);
		await expect(enforceStudioRatchetBoundary(isolated, { flow: "router", action: "check" })).rejects.toThrow(
			"stopped",
		);
		for (let i = 0; i < 50; i++) {
			const record = await Bun.file(path.join(source, ".omp/studio-ratchet", run.id + ".json")).json();
			if (record.state === "stopped") break;
			await Bun.sleep(5);
		}
		expect(await Bun.file(path.join(source, "prompt.md")).text()).toBe("user uncommitted draft");
		expect(await Bun.file(path.join(isolated, "prompt.md")).text()).toBe("candidate evidence");
		const restored = new StudioRatchetService(session);
		expect(await restored.execute({ kind: "ratchet.read", sessionId: session.sessionId, id: run.id })).toMatchObject({
			state: "stopped",
		});
		expect(runner).toHaveBeenCalledTimes(1);
		restored.dispose();
	} finally {
		service.dispose();
		finished.resolve({ result: { id: "native-agent", exitCode: 0 } } as StructuredSubagentResult);
		await Bun.sleep(20);
		for (const [directory, root] of [
			[source, os.tmpdir()],
			[base, getWorktreeDir("")],
		]) {
			const rel = path.relative(root!, directory!);
			expect(rel.startsWith("..") || path.isAbsolute(rel) || !rel).toBe(false);
			await fs.rm(directory!, { recursive: true, force: true });
		}
	}
});
