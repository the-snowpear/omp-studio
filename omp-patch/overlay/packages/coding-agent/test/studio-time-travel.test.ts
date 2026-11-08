import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { StudioTimeTravelBoundary, type TimeTravelCaptureRequest } from "../src/studio/services/time-travel-boundary";
import { StudioTreeService } from "../src/studio/services/tree-service";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

test("real turns capture their boundaries and exact restores persist while keeping later branches", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-time-travel-runtime-"));
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-only");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const provider = createMockModel({ id: model.id, provider: model.provider, handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		initialState: { model, systemPrompt: [], tools: [] },
		convertToLlm,
		getApiKey: () => "test-only",
		streamFn: provider.stream,
	});
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(auth, join(directory, "models.yml")),
	});
	const boundary = new StudioTimeTravelBoundary(session, 1);
	const points: TimeTravelCaptureRequest[] = [];
	boundary.subscribe(request => {
		points.push(request);
		boundary.complete(request.requestId);
	});
	session.setBeforeNextUserTurn(() => boundary.capture("before"));
	session.setAfterUserTurn(() => boundary.capture("after"));
	agent.addBeforeQueuedMessageDequeueHook(async () => {
		if ([...agent.peekSteeringQueue(), ...agent.peekFollowUpQueue()].some(message => message.role === "user"))
			await boundary.capture("before");
	});
	try {
		await session.prompt("first request");
		await session.prompt("later request");
		expect(points.map(point => point.phase)).toEqual(["before", "after", "before", "after"]);
		const firstLeaf = points[1]!.leafId!;
		const laterLeaf = points[3]!.leafId!;
		const tree = new StudioTreeService(session);
		await tree.navigate("restore", { targetId: firstLeaf, exactLeaf: true });
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
		let reopened = await SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getBranch().some(entry => entry.id === firstLeaf)).toBe(true);
		expect(reopened.getBranch().some(entry => entry.id === laterLeaf)).toBe(false);
		expect(reopened.getEntry(laterLeaf)).toBeDefined();

		const yielded = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let first = true;
		agent.setOnBeforeYield(async () => {
			if (first) {
				first = false;
				yielded.resolve();
				await release.promise;
			}
		});
		const prior = points.length;
		const running = session.prompt("queue origin");
		await yielded.promise;
		await session.prompt("queued follow up", { streamingBehavior: "followUp" });
		release.resolve();
		await running;
		const deadline = Date.now() + 5000;
		while (points.length < prior + 4 || session.isStreaming) {
			if (Date.now() > deadline) throw new Error("Queued turn did not finish");
			await Bun.sleep(10);
		}
		expect(points.slice(prior).map(point => point.phase)).toEqual(["before", "after", "before", "after"]);

		const abortYield = Promise.withResolvers<void>(),
			abortRelease = Promise.withResolvers<void>();
		agent.setOnBeforeYield(async () => {
			abortYield.resolve();
			await abortRelease.promise;
		});
		const beforeAbort = points.length;
		const abortRun = session.prompt("interrupt me");
		await abortYield.promise;
		const aborting = session.abort();
		abortRelease.resolve();
		await Promise.all([aborting, abortRun]);
		expect(points.slice(beforeAbort).map(point => point.phase)).toEqual(["before", "after"]);
		await tree.navigate("root", { targetId: "root", exactLeaf: true, restoreRoot: true });
		reopened = await SessionManager.open(manager.getSessionFile()!);
		expect(reopened.buildSessionContext().messages).toHaveLength(0);
		expect(reopened.getEntry(laterLeaf)).toBeDefined();
	} finally {
		boundary.dispose();
		await session.dispose();
		auth.close();
	}
});
