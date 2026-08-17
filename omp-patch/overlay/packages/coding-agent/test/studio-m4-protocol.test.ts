import { describe, expect, test } from "bun:test";
import { parseStudioRequest, StudioFrameError } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";

const base = { type: "studio.request" as const, requestId: "request-m4", runtimeEpoch: 1 };

describe("M4 Runtime protocol mirror", () => {
	test("parses interaction responses and explicit TUI transfer", () => {
		expect(
			parseStudioRequest({
				...base,
				operation: {
					kind: "interaction.respond",
					interactionId: "interaction-1",
					commandId: "command-1",
					decision: "submit",
					value: true,
				},
			}).operation.kind,
		).toBe("interaction.respond");
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "tui.transfer", commandId: "command-1", interactionId: "interaction-1" },
			}).operation.kind,
		).toBe("tui.transfer");
	});

	test("parses fast and prewalk session operations", () => {
		for (const operation of [
			{ kind: "session.fast.set", enabled: true },
			{ kind: "session.prewalk.arm" },
			{ kind: "session.prewalk.arm", target: "@smol" },
			{ kind: "session.prewalk.disarm" },
		]) {
			expect(parseStudioRequest({ ...base, operation }).operation.kind as string).toBe(operation.kind);
		}
		for (const operation of [
			{ kind: "session.fast.set", enabled: "yes" },
			{ kind: "session.prewalk.arm", target: "" },
			{ kind: "session.prewalk.disarm", extra: true },
		]) {
			expect(() => parseStudioRequest({ ...base, operation })).toThrow(StudioFrameError);
		}
	});

	test("parses session model and thinking operations", () => {
		for (const operation of [
			{ kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5" },
			{ kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5", thinking: "high" },
			{ kind: "session.thinking.set", level: "auto" },
			{ kind: "session.thinking.set", level: "off" },
		]) {
			expect(parseStudioRequest({ ...base, operation }).operation.kind as string).toBe(operation.kind);
		}
		for (const operation of [
			{ kind: "session.model.set", selector: "" },
			{ kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5", thinking: "inherit" },
			{ kind: "session.thinking.set", level: "inherit" },
			{ kind: "session.thinking.set", extra: true },
		]) {
			expect(() => parseStudioRequest({ ...base, operation })).toThrow(StudioFrameError);
		}
	});

	test("rejects unknown fields and non-JSON argument values", () => {
		for (const operation of [
			{ kind: "interaction.respond", interactionId: "i", commandId: "c", decision: "maybe" },
			{ kind: "interaction.respond", interactionId: "i", commandId: "c", decision: "cancel", extra: true },
			{ kind: "operator.invoke", commandId: "builtin.force", arguments: Number.NaN },
			{ kind: "operator.invoke", commandId: "builtin.force", arguments: new Date() },
			{ kind: "tui.transfer", commandId: "", interactionId: "i" },
		]) {
			expect(() => parseStudioRequest({ ...base, operation })).toThrow(StudioFrameError);
		}
	});

	test("parses TAN and OMFG composite operations with strict fields", () => {
		for (const operation of [
			{ kind: "tan.start", work: "review the tests" },
			{ kind: "omfg.generate", complaint: "avoid this mistake" },
			{ kind: "omfg.amend", candidateId: "candidate-1", feedback: "make it narrower" },
			{ kind: "omfg.commit", candidateId: "candidate-1", scope: "project", overwrite: false },
		]) {
			expect(parseStudioRequest({ ...base, operation }).operation.kind as string).toBe(operation.kind);
		}
		for (const operation of [
			{ kind: "tan.start", work: "" },
			{ kind: "omfg.generate", complaint: "", extra: true },
			{ kind: "omfg.amend", candidateId: "candidate-1", feedback: "" },
			{ kind: "omfg.commit", candidateId: "candidate-1", scope: "machine", overwrite: false },
		]) {
			expect(() => parseStudioRequest({ ...base, operation })).toThrow(StudioFrameError);
		}
	});

	test("parses Agent Hub and Job operations and rejects unsafe lifecycle inputs", () => {
		for (const operation of [
			{ kind: "agent.list", includeTerminal: true },
			{ kind: "agent.spawn", definition: "researcher", assignment: "audit", isolation: "patch", effort: "hi" },
			{ kind: "agent.send", agentId: "Child-1", expectedGeneration: 1, text: "continue", mode: "steer" },
			{ kind: "agent.transcript.read", agentId: "Child-1", limit: 50 },
			{ kind: "agent.conversation.read", agentId: "Child-1", limit: 50 },
			{ kind: "agent.subscribe", level: "events" },
			{ kind: "job.list", ownerAgentId: "Main", includeRecent: true },
			{ kind: "job.cancel", jobId: "job-1", expectedGeneration: 1 },
			{ kind: "job.subscribe" },
		]) {
			expect(parseStudioRequest({ ...base, operation }).operation.kind as string).toBe(operation.kind);
		}
		for (const operation of [
			{ kind: "agent.spawn", definition: "researcher", assignment: "audit", isolation: "none" },
			{ kind: "agent.spawn", definition: "researcher", assignment: "audit", effort: "high" },
			{ kind: "agent.send", agentId: "Child-1", expectedGeneration: 0, text: "continue", mode: "prompt" },
			{ kind: "agent.kill", agentId: "Child-1", expectedGeneration: 1, force: true },
			{ kind: "agent.subscribe", level: "all" },
			{ kind: "job.cancel", jobId: "job-1", expectedGeneration: 0 },
			{ kind: "job.subscribe", extra: true },
		]) {
			expect(() => parseStudioRequest({ ...base, operation })).toThrow(StudioFrameError);
		}
	});
});
