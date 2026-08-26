import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ConversationRuntimeEvent } from "@oh-my-pi/pi-coding-agent/studio/conversation-protocol";
import { ConversationLiveProjector } from "@oh-my-pi/pi-coding-agent/studio/services/conversation-live-projector";
import { ConversationProjectorHub } from "@oh-my-pi/pi-coding-agent/studio/services/conversation-projector-hub";

function fakeSession(sessionId: string): AgentSession {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => null,
			getBranch: () => [],
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

function projectorFor(sessionId: string): ConversationLiveProjector {
	return new ConversationLiveProjector({
		sessionId,
		runtimeEpoch: 3,
		reserveMessageId: () => `${sessionId}-msg`,
	});
}

describe("ConversationProjectorHub", () => {
	test("binds existing sub agents and skips Main", () => {
		const registry = new AgentRegistry();
		const main = fakeSession("main-sess");
		const child = fakeSession("child-sess");
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: main });
		registry.register({ id: "agent-1", displayName: "deps", kind: "sub", session: child });
		const created: string[] = [];
		const hub = new ConversationProjectorHub({
			main: projectorFor("main-sess"),
			registry,
			runtimeEpoch: () => 3,
			createChild: ref => {
				created.push(ref.id);
				return projectorFor(ref.session?.sessionManager.getSessionId() ?? "missing");
			},
		});
		expect(created).toEqual(["agent-1"]);
		hub.dispose();
	});

	test("session_changed attach binds and detach disposes", () => {
		const registry = new AgentRegistry();
		const created: string[] = [];
		const disposed: string[] = [];
		const hub = new ConversationProjectorHub({
			main: projectorFor("main-sess"),
			registry,
			runtimeEpoch: () => 3,
			createChild: ref => {
				created.push(ref.id);
				const projector = projectorFor("child-sess");
				const original = projector.dispose.bind(projector);
				projector.dispose = () => {
					disposed.push(ref.id);
					original();
				};
				return projector;
			},
		});
		const session = fakeSession("child-sess");
		registry.register({ id: "agent-1", displayName: "deps", kind: "sub", session: null, status: "parked" });
		expect(created).toEqual([]);
		registry.attachSession("agent-1", session);
		expect(created).toEqual(["agent-1"]);
		registry.detachSession("agent-1");
		expect(disposed).toEqual(["agent-1"]);
		hub.dispose();
	});

	test("replacing the session instance disposes the previous child projector", () => {
		const registry = new AgentRegistry();
		const created: string[] = [];
		const disposed: string[] = [];
		const first = fakeSession("child-a");
		registry.register({ id: "agent-1", displayName: "deps", kind: "sub", session: first });
		const hub = new ConversationProjectorHub({
			main: projectorFor("main-sess"),
			registry,
			runtimeEpoch: () => 3,
			createChild: ref => {
				created.push(ref.session?.sessionManager.getSessionId() ?? "missing");
				const projector = projectorFor(ref.session?.sessionManager.getSessionId() ?? "missing");
				const original = projector.dispose.bind(projector);
				projector.dispose = () => {
					disposed.push(projector.sessionId);
					original();
				};
				return projector;
			},
		});
		expect(created).toEqual(["child-a"]);
		registry.attachSession("agent-1", fakeSession("child-b"));
		expect(created).toEqual(["child-a", "child-b"]);
		expect(disposed).toEqual(["child-a"]);
		hub.dispose();
	});

	test("fans main events once and does not bind a second main projector", () => {
		const registry = new AgentRegistry();
		const mainProjector = projectorFor("main-sess");
		const seen: ConversationRuntimeEvent["sessionId"][] = [];
		const hub = new ConversationProjectorHub({
			main: mainProjector,
			registry,
			runtimeEpoch: () => 3,
			createChild: () => projectorFor("child-sess"),
		});
		hub.onEvent(event => seen.push(event.sessionId));
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: fakeSession("main-sess") });
		mainProjector.project({
			type: "message_start",
			message: { role: "user", content: "hello", timestamp: Date.now() },
		});
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every(sessionId => sessionId === "main-sess")).toBe(true);
		hub.dispose();
	});
});
