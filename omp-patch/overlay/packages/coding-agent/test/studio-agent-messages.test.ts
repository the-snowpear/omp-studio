import { expect, test } from "bun:test";
import { SessionManager } from "../src/session/session-manager";
import { receivedAgentMessages } from "../src/studio/services/agent-messages-service";

test("an agent's received IRC messages are read back from what its session persisted", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "audit the lockfile", timestamp: 1 });
	// A peer's message, delivered as an `irc:incoming` record (the body the model saw is wrapped; details keep the raw one).
	manager.appendCustomMessageEntry(
		"irc:incoming",
		'<irc from="typecheck-1">wrapped for the model</irc>',
		true,
		{
			id: "7001",
			from: "typecheck-1",
			message: "14 errors, all in `MermaidBlock.tsx`.",
			replyTo: "6990",
			progress: true,
		},
		"agent",
	);
	// A broadcast leg from the main agent.
	manager.appendCustomMessageEntry(
		"irc:incoming",
		"wrapped",
		true,
		{ id: "7002", from: "Main", message: "Hold writes to renderer/.", broadcast: true },
		"agent",
	);
	// A parent's message to a busy child lands as a steer that keeps sender and body.
	manager.appendMessage({
		role: "user",
		content: "<parent-irc>wrapped</parent-irc>",
		parentIrc: { from: "Main", body: "Stop after the audit." },
		attribution: "agent",
		steering: true,
		timestamp: 42_000,
	} as never);
	// Neither unrelated custom records nor malformed IRC details are messages.
	manager.appendCustomMessageEntry("async-result", "job done", true, { from: "Main", message: "not irc" });
	manager.appendCustomMessageEntry("irc:incoming", "wrapped", true, { id: "bad", message: "no sender" });

	const messages = receivedAgentMessages("deps-1", manager.getBranch());

	expect(messages.map(message => ({ ...message, at: undefined }))).toEqual([
		{
			id: "7001",
			from: "typecheck-1",
			to: "deps-1",
			body: "14 errors, all in `MermaidBlock.tsx`.",
			at: undefined,
			replyTo: "6990",
			progress: true,
		},
		{ id: "7002", from: "Main", to: "deps-1", body: "Hold writes to renderer/.", at: undefined, broadcast: true },
		{ id: expect.any(String), from: "Main", to: "deps-1", body: "Stop after the audit.", at: undefined },
	]);
	expect(messages[0]!.at).toBeGreaterThan(0);
	expect(messages[2]!.at).toBe(42_000);
});
