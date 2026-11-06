import { describe, expect, it } from "bun:test";
import { ComputerControlPolicy } from "../src/studio/services/computer-control-policy";
import type { ComputerControlState } from "../src/studio/computer-workspace-protocol";
import { SessionManager } from "../src/session/session-manager";
import { ConversationLiveProjector } from "../src/studio/services/conversation-live-projector";
import type { ConversationRuntimeEvent } from "../src/studio/conversation-protocol";

describe("Computer persistent stop policy", () => {
	it("visible continue has a stable transcript id without consuming the next real user's reservation", () => {
		const manager = SessionManager.inMemory();
		const events: ConversationRuntimeEvent[] = [];
		const projector = new ConversationLiveProjector({
			sessionId: manager.getSessionId(),
			runtimeEpoch: 1,
			reserveMessageId: input => manager.reserveMessageId(input.role),
			reserveCustomMessageId: input => manager.reserveCustomMessageId(input.customType, input.timestamp),
		});
		projector.onEvent(event => events.push(event));
		const message = {
			role: "custom" as const,
			customType: "studio-computer-continue",
			content: "Explicit user continuation",
			display: true,
			attribution: "user" as const,
			timestamp: 50,
			details: { revision: 1 },
		};
		projector.project({ type: "message_start", message });
		projector.project({ type: "message_end", message });
		const customId = manager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution,
			message.timestamp,
		);
		const started = events.find(event => event.kind === "conversation.message.started");
		expect(started).toMatchObject({ role: "user", messageId: customId });
		const userId = manager.reserveMessageId("user");
		manager.appendCustomMessageEntry("agent-note", "not a user", true, undefined, "agent", 51);
		expect(manager.appendMessage({ role: "user", content: "Next user input", timestamp: 52 })).toBe(userId);
		expect(userId).not.toBe(customId);
		projector.dispose();
	});
	it("closes the gate before cancellation completes and does not acknowledge failed persistence", async () => {
		const cleanup = Promise.withResolvers<void>();
		let failPersistence = false;
		const policy = new ComputerControlPolicy("root", {
			changed() {},
			cancel: () => cleanup.promise,
			persist: async () => {
				if (failPersistence) throw new Error("disk full");
			},
		});
		const old = await policy.authorize();
		const stop = policy.stop("handoff");
		expect(old.signal.aborted).toBe(true);
		expect(policy.state.status).toBe("stopping");
		await expect(policy.authorize()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		failPersistence = true;
		cleanup.resolve();
		await expect(stop).rejects.toThrow("disk full");
		expect(policy.state.status).toBe("unconfirmed");
		expect(() => policy.prepareContinue(policy.state.revision)).toThrow();
	});
	it("only consumes its exact visible new user intent at execution, never an old queue or synthetic message", async () => {
		const durable: ComputerControlState[] = [];
		const policy = new ComputerControlPolicy("root", {
			changed() {},
			cancel: async () => {},
			persist: async state => {
				durable.push(state);
			},
		});
		const old = await policy.authorize();
		await policy.stop();
		const revision = policy.state.revision;
		const { intent } = policy.prepareContinue(revision);
		expect(policy.prepareContinue(revision).fresh).toBe(false);
		policy.consume("root", { role: "user", content: "continue" });
		policy.consume("root", {
			role: "custom",
			customType: "studio-computer-continue",
			display: false,
			attribution: "user",
			details: intent,
		});
		await expect(policy.authorize()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		policy.consume("root", {
			role: "custom",
			customType: "studio-computer-continue",
			display: true,
			attribution: "user",
			details: intent,
		});
		const permit = await policy.authorize();
		expect(permit.signal.aborted).toBe(false);
		expect(old.signal.aborted).toBe(true);
		expect(durable.at(-1)?.status).toBe("allowed");
		policy.consume("root", { role: "user", content: "Old queued task", timestamp: 1 });
		await expect(policy.authorize()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		await policy.stop();
		policy.consume("root", {
			role: "custom",
			customType: "studio-computer-continue",
			display: true,
			attribution: "user",
			details: intent,
		});
		await expect(policy.authorize()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(() => policy.prepareContinue(revision)).toThrow();
	});
	it("a reconstructed stopped scope stays closed and cannot consume a previous process's intent", async () => {
		const restored: ComputerControlState = { status: "continuing", revision: 7, updatedAt: 1, foreground: "held" };
		const policy = new ComputerControlPolicy(
			"root",
			{ changed() {}, cancel: async () => {}, persist: async () => {} },
			restored,
		);
		expect(policy.state).toMatchObject({ status: "unconfirmed", foreground: "none", revision: 7 });
		await expect(policy.authorize()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		await policy.stop();
		expect(policy.prepareContinue(8).fresh).toBe(true);
	});
});
