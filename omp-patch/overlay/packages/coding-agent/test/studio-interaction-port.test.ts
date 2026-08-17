import { describe, expect, test } from "bun:test";
import type {
	StudioInteractionRequiredEvent,
	StudioInteractionResolvedEvent,
} from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { StudioRuntimeCommandArbiter } from "@oh-my-pi/pi-coding-agent/studio/command-arbiter";
import {
	StudioInteractionError,
	StudioInteractionGateway,
	StudioRemoteInteractionPort,
	StudioScriptedInteractionPort,
} from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";

function fixture() {
	const arbiter = new StudioRuntimeCommandArbiter(
		() => ({ runtimeEpoch: 1, stateVersion: 0, isStreaming: false, isCompacting: false }),
		[],
	);
	const opened: StudioInteractionRequiredEvent[] = [];
	const resolved: StudioInteractionResolvedEvent[] = [];
	const port = new StudioRemoteInteractionPort(
		arbiter,
		(_pending, event) => opened.push(event),
		event => resolved.push(event),
	);
	return { arbiter, opened, port, resolved };
}

describe("WP-040 Runtime InteractionPort", () => {
	test("confirm publishes one opaque request and resolves only an explicit true submit", async () => {
		const { opened, port, resolved } = fixture();
		const result = port.confirm({
			commandId: "command-1",
			title: "Confirm",
			message: "Proceed?",
			destructive: true,
		});
		expect(opened).toHaveLength(1);
		const request = opened[0]!.request;
		expect(request).toMatchObject({ kind: "confirm", commandId: "command-1", destructive: true });
		port.respond({
			kind: "interaction.respond",
			interactionId: request.interactionId,
			commandId: request.commandId,
			decision: "submit",
			value: true,
		});
		await expect(result).resolves.toBe(true);
		expect(port.pending()).toBeUndefined();
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toMatchObject({
			kind: "interaction.resolved",
			interactionId: request.interactionId,
			commandId: request.commandId,
			leaseGeneration: 1,
			outcome: "submitted",
		});
	});

	test("cancel resolves without approval and duplicate or wrong-owner responses fail closed", async () => {
		const { opened, port, resolved } = fixture();
		const result = port.confirm({ commandId: "command-2", title: "Confirm", message: "Proceed?" });
		const request = opened[0]!.request;
		expect(() =>
			port.respond(
				{
					kind: "interaction.respond",
					interactionId: request.interactionId,
					commandId: request.commandId,
					decision: "cancel",
				},
				"tui",
			),
		).toThrow("does not own");
		port.respond({
			kind: "interaction.respond",
			interactionId: request.interactionId,
			commandId: request.commandId,
			decision: "cancel",
		});
		await expect(result).resolves.toBe(false);
		expect(resolved[0]?.outcome).toBe("cancelled");
		expect(() =>
			port.respond({
				kind: "interaction.respond",
				interactionId: request.interactionId,
				commandId: request.commandId,
				decision: "cancel",
			}),
		).toThrow("stale");
	});

	test("explicit transfer increments the lease and changes the only valid owner", async () => {
		const { opened, port } = fixture();
		const result = port.confirm({ commandId: "command-3", title: "Confirm", message: "Proceed?" });
		const request = opened[0]!.request;
		expect(port.transfer(request.interactionId, request.commandId, "gui", "tui")).toMatchObject({
			request: { kind: "confirm", commandId: "command-3" },
			owner: "tui",
			leaseGeneration: 2,
		});
		expect(() =>
			port.respond({
				kind: "interaction.respond",
				interactionId: request.interactionId,
				commandId: request.commandId,
				decision: "submit",
				value: true,
			}),
		).toThrow("does not own");
		port.respond(
			{
				kind: "interaction.respond",
				interactionId: request.interactionId,
				commandId: request.commandId,
				decision: "submit",
				value: true,
			},
			"tui",
		);
		await expect(result).resolves.toBe(true);
	});

	test("Runtime gateway lets the transferred TUI resolve the same pending interaction", async () => {
		const { opened, port } = fixture();
		const gateway = new StudioInteractionGateway();
		gateway.bind(port);
		const result = port.confirm({ commandId: "command-4", title: "Confirm", message: "Proceed?" });
		const request = opened[0]!.request;
		port.transfer(request.interactionId, request.commandId, "gui", "tui");
		expect(gateway.pending()).toMatchObject({ owner: "tui", leaseGeneration: 2 });
		gateway.respondFromTui({
			kind: "interaction.respond",
			interactionId: request.interactionId,
			commandId: request.commandId,
			decision: "submit",
			value: true,
		});
		await expect(result).resolves.toBe(true);
		gateway.unbind(port);
		expect(() =>
			gateway.respondFromTui({
				kind: "interaction.respond",
				interactionId: request.interactionId,
				commandId: request.commandId,
				decision: "cancel",
			}),
		).toThrow(StudioInteractionError);
	});

	test("cancel/expire emit aborted/expired resolved events with the full request in pending()", async () => {
		const { opened, port, resolved } = fixture();
		const result = port.confirm({ commandId: "command-5", title: "Confirm", message: "Proceed?" });
		const request = opened[0]!.request;
		expect(port.pending()).toMatchObject({
			request: { kind: "confirm", commandId: "command-5", title: "Confirm", interactionId: request.interactionId },
			owner: "gui",
			leaseGeneration: 1,
		});
		port.cancel("Runtime is shutting down");
		await expect(result).rejects.toThrow("shutting down");
		expect(resolved[0]).toMatchObject({ outcome: "aborted", leaseGeneration: 1 });
		const second = port.confirm({ commandId: "command-6", title: "Confirm", message: "Proceed?" });
		port.cancel("Ask timed out", "expired");
		await expect(second).rejects.toThrow("timed out");
		expect(resolved[1]?.outcome).toBe("expired");
		expect(port.pending()).toBeUndefined();
	});

	test("scripted port supplies deterministic service-test responses", async () => {
		const port = new StudioScriptedInteractionPort([true, "one", "input", "edited", true]);
		await expect(port.confirm({ commandId: "c", title: "x", message: "x" })).resolves.toBe(true);
		await expect(port.select({ commandId: "c", title: "x", options: [] })).resolves.toBe("one");
		await expect(port.input({ commandId: "c", title: "x" })).resolves.toBe("input");
		await expect(port.editor({ commandId: "c", title: "x" })).resolves.toBe("edited");
		await expect(port.approve({ commandId: "c", title: "x", approvalType: "tool", details: {} })).resolves.toBe(true);
	});

	test("approve resolves strictly true only for an explicit submit with value true", async () => {
		const { opened, port } = fixture();
		const result = port.approve({
			commandId: "command-7",
			title: "Approve bash?",
			approvalType: "bash",
			details: { risk: "high" },
		});
		const request = opened[0]!.request;
		expect(request).toMatchObject({ kind: "approval", approvalType: "bash", details: { risk: "high" } });
		// deny: cancel resolves false
		port.respond({
			kind: "interaction.respond",
			interactionId: request.interactionId,
			commandId: request.commandId,
			decision: "cancel",
		});
		await expect(result).resolves.toBe(false);
		// allow: submit with value true resolves true
		const allowed = port.approve({ commandId: "command-8", title: "Approve?", approvalType: "bash", details: {} });
		const request2 = opened[1]!.request;
		port.respond({
			kind: "interaction.respond",
			interactionId: request2.interactionId,
			commandId: request2.commandId,
			decision: "submit",
			value: true,
		});
		await expect(allowed).resolves.toBe(true);
		// any other value is not an approval
		const nonTrue = port.approve({ commandId: "command-9", title: "Approve?", approvalType: "bash", details: {} });
		const request3 = opened[2]!.request;
		port.respond({
			kind: "interaction.respond",
			interactionId: request3.interactionId,
			commandId: request3.commandId,
			decision: "submit",
			value: "yes",
		});
		await expect(nonTrue).resolves.toBe(false);
	});
});
