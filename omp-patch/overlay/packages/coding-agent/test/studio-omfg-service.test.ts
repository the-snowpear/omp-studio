import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	StudioOmfgError,
	StudioOmfgService,
	type StudioOmfgStoragePort,
} from "@oh-my-pi/pi-coding-agent/studio/services/omfg-service";

const rule = (name = "no-bad") =>
	JSON.stringify({
		name,
		description: "Avoid the bad behavior",
		condition: "bad",
		scope: "text",
		body: "Use the safe behavior.",
	});

function harness(replies: string[], options: { exists?: boolean; register?: boolean; confirm?: boolean } = {}) {
	const writes: Array<{ path: string; content: string; atomic: boolean }> = [];
	const registered: unknown[] = [];
	const confirmations: unknown[] = [];
	const rollback: string[] = [];
	const secretPath = "D:/secret/project/.omp/rules/no-bad.md";
	const storage: StudioOmfgStoragePort = {
		resolveRulePath: () => secretPath,
		exists: async () => options.exists ?? false,
		write: async (path, content) => {
			writes.push({ path, content, atomic: false });
		},
		writeAtomic: async (path, content) => {
			writes.push({ path, content, atomic: true });
		},
	};
	const service = new StudioOmfgService(
		{
			runEphemeralTurn: async () => ({
				replyText: replies.shift() ?? "",
				assistantMessage: { role: "assistant", content: [] } as unknown as AssistantMessage,
			}),
			getMessages: () => [],
		},
		storage,
		{
			register: value => {
				registered.push(value);
				return options.register ?? true;
			},
		},
		{
			confirm: async input => {
				confirmations.push(input);
				return options.confirm ?? false;
			},
		},
		{
			idGenerator: () => "candidate-1",
			rollback: async path => {
				rollback.push(path);
			},
		},
	);
	return { service, writes, registered, confirmations, rollback, secretPath };
}

describe("StudioOmfgService", () => {
	test("generates and amends a bounded path-free candidate without writing", async () => {
		const h = harness([rule(), rule("no-worse")]);
		const generated = await h.service.generate("stop doing bad things");
		expect(generated.candidateId).toBe("candidate-1");
		expect(generated.ruleName).toBe("no-bad");
		expect(generated.validated).toBeFalse();
		expect(h.writes).toHaveLength(0);

		const amended = await h.service.amend(generated.candidateId, "make it narrower");
		expect(amended.candidateId).toBe(generated.candidateId);
		expect(amended.ruleName).toBe("no-worse");
		expect(JSON.stringify(amended)).not.toContain("D:/secret");
	});

	test("keeps the prior candidate when amended output is invalid and rejects stale ids", async () => {
		const h = harness([rule(), "not json"]);
		const generated = await h.service.generate("complaint");
		await expect(h.service.amend(generated.candidateId, "change it")).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
		});
		await expect(h.service.commit("stale", "project", false, "cmd-test")).rejects.toMatchObject({
			code: "INTERACTION_STALE",
		});
	});

	test("confirms overwrite, uses atomic write, registers live, and consumes candidate", async () => {
		const h = harness([rule()], { exists: true, confirm: true });
		const generated = await h.service.generate("complaint");
		const result = await h.service.commit(generated.candidateId, "project", false, "cmd-test");
		expect(result).toEqual({ committed: true, scope: "project", ruleName: "no-bad" });
		expect(h.confirmations).toHaveLength(1);
		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]?.atomic).toBeTrue();
		expect(h.registered).toHaveLength(1);
		await expect(h.service.commit(generated.candidateId, "project", true, "cmd-test")).rejects.toBeInstanceOf(
			StudioOmfgError,
		);
	});

	test("cancellation writes nothing and registration failure rolls back without leaking the path", async () => {
		const cancelled = harness([rule()], { exists: true, confirm: false });
		const first = await cancelled.service.generate("complaint");
		expect(await cancelled.service.commit(first.candidateId, "project", false, "cmd-test")).toMatchObject({
			committed: false,
		});
		expect(cancelled.writes).toHaveLength(0);

		const failed = harness([rule()], { register: false });
		const second = await failed.service.generate("complaint");
		try {
			await failed.service.commit(second.candidateId, "project", true, "cmd-test");
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toMatchObject({ code: "INTERNAL_ERROR", partial: true });
			expect(String(error)).not.toContain(failed.secretPath);
		}
		expect(failed.rollback).toEqual([failed.secretPath]);
	});
});
