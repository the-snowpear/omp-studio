import { describe, expect, test } from "bun:test";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { presentHtmlForm } from "@oh-my-pi/pi-coding-agent/studio/services/form-presentation";
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
		await expect(port.approve({ commandId: "c", title: "x", approvalType: "tool", details: {} })).resolves.toBe(
			"once",
		);
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
		await expect(result).resolves.toBe("deny");
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
		await expect(allowed).resolves.toBe("once");
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
		await expect(nonTrue).resolves.toBe("deny");
	});
});

describe("Studio native form interaction port", () => {
	test("keeps full text and media only in a leased transient body, not the pending snapshot", async () => {
		const { port, opened } = fixture();
		const caption = "界".repeat(3000);
		const form = await presentHtmlForm(
			parseHtmlForm(
				`<form><p>${caption}</p><fieldset><legend>Details</legend><label>Password<input type="password" name="password" value="private-prefill"></label><img src="data:text/plain,not-an-image" alt="Unavailable diagram"><svg viewBox="0 0 20 20" aria-label="Flow"><rect width="20" height="20"/></svg></fieldset></form>`,
			),
			{ cwd: process.cwd() },
		);
		const result = port.form({ commandId: "native-body", title: "Details", form });
		const pending = port.pending();
		if (pending?.request.kind !== "form") throw new Error("Expected form");
		expect(new TextEncoder().encode(pending.request.summary).length).toBeLessThanOrEqual(483);
		expect(JSON.stringify(pending)).not.toContain("private-prefill");
		expect(JSON.stringify(opened)).not.toContain(caption);
		const body = port.readForm(pending.request.interactionId, pending.leaseGeneration).form;
		const blocks = body.sections.flatMap(section => section.blocks);
		expect(blocks.find(block => block.kind === "text")).toMatchObject({ spans: [{ text: caption }] });
		expect(blocks.find(block => block.kind === "media-unavailable")).toMatchObject({ alt: "Unavailable diagram" });
		expect(blocks.find(block => block.kind === "graphic")).toMatchObject({ format: "svg", alt: "Flow" });
		port.respond({
			kind: "interaction.respond",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			leaseGeneration: pending.leaseGeneration,
			decision: "cancel",
		});
		await expect(result).resolves.toBeUndefined();
		expect(() => port.readForm(pending.request.interactionId, pending.leaseGeneration)).toThrow("stale");
	});

	test("preserves hidden and duplicate named data and native scalar/array checkbox semantics", async () => {
		const { port } = fixture();
		const form = await presentHtmlForm(
			parseHtmlForm(
				`<form><input type="hidden" name="kind" value="deploy"><input type="hidden" name="mode" value="fallback"><input name="shared" value="earlier"><input type="number" name="qty" value="2"><label><input type="checkbox" name="shared" value="on">Override</label><label><input type="checkbox" name="mode" value="on">Enable</label><label><input type="checkbox" name="features" value="a">Alpha</label><label><input type="checkbox" name="features" value="b">Beta</label><label><input type="checkbox" name="lone" value="yes">Accept</label><input value="unnamed"></form>`,
			),
			{ cwd: process.cwd() },
		);
		const question = form.fields.find(field => field.name === "features")!.question;
		const result = port.form({ commandId: "native-data", title: "Data", form });
		const pending = port.pending()!;
		port.respond({
			kind: "interaction.respond",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			decision: "submit",
			value: {
				data: {
					kind: "not-editable",
					shared: "earlier",
					mode: "fallback",
					qty: "3.50",
					features: ["b"],
					lone: "yes",
					unnamed: "not-submitted",
				},
				notes: [{ name: "features", value: "b", text: " Keep this ", question }],
			},
		});
		const answer = await result;
		expect(answer?.data).toEqual({
			kind: "deploy",
			shared: "earlier",
			mode: "fallback",
			qty: 3.5,
			features: ["b"],
			lone: "yes",
		});
		expect(answer?.notes).toEqual([{ name: "features", question, option: "Beta", value: "b", text: "Keep this" }]);
	});

	test("keeps a note on the chosen row when two option labels share the same submitted value", async () => {
		const { port } = fixture();
		const form = await presentHtmlForm(
			parseHtmlForm(
				`<form><fieldset><legend>Pick</legend><label><input type="radio" name="pick" value="same">First label</label><label><input type="radio" name="pick" value="same">Second label</label></fieldset></form>`,
			),
			{ cwd: process.cwd() },
		);
		const result = port.form({ commandId: "duplicate-option-values", title: "Pick", form });
		const pending = port.pending()!;
		port.respond({
			kind: "interaction.respond",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			decision: "submit",
			value: {
				data: { pick: "same" },
				notes: [
					{
						name: "pick",
						question: "Pick",
						option: "Second label",
						value: "same",
						text: " Details for the second row ",
					},
				],
			},
		});
		await expect(result).resolves.toEqual({
			data: { pick: "same" },
			notes: [
				{
					name: "pick",
					question: "Pick",
					option: "Second label",
					value: "same",
					text: "Details for the second row",
				},
			],
		});
	});

	test("rejects an old GUI lease after transfer to TUI and back without closing the current form", async () => {
		const { port, resolved } = fixture();
		const form = await presentHtmlForm(
			parseHtmlForm(`<form><label>Name<input name="name" value="initial"></label></form>`),
			{ cwd: process.cwd() },
		);
		const result = port.form({ commandId: "native-lease", title: "Name", form });
		const original = port.pending()!;
		port.transfer(original.request.interactionId, original.request.commandId, "gui", "tui");
		expect(() => port.readForm(original.request.interactionId, original.leaseGeneration)).toThrow("does not own");
		const current = port.transfer(original.request.interactionId, original.request.commandId, "tui", "gui");
		expect(() =>
			port.respond({
				kind: "interaction.respond",
				interactionId: original.request.interactionId,
				commandId: original.request.commandId,
				leaseGeneration: original.leaseGeneration,
				decision: "submit",
				value: { data: { name: "old owner" } },
			}),
		).toThrow("lease is stale");
		expect(port.pending()?.leaseGeneration).toBe(current.leaseGeneration);
		port.respond({
			kind: "interaction.respond",
			interactionId: current.request.interactionId,
			commandId: current.request.commandId,
			leaseGeneration: current.leaseGeneration,
			decision: "submit",
			value: { data: { name: "current owner" } },
		});
		await expect(result).resolves.toEqual({ data: { name: "current owner" } });
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.leaseGeneration).toBe(current.leaseGeneration);
	});

	test("aborts a queued native form without cancelling the other dialog that owns the surface", async () => {
		const { port, opened } = fixture();
		const first = port.confirm({ commandId: "first-dialog", title: "First", message: "Proceed?" });
		const current = port.pending()!;
		const controller = new AbortController();
		const form = await presentHtmlForm(parseHtmlForm(`<form><input name="name" value="queued draft"></form>`), {
			cwd: process.cwd(),
		});
		const queued = port.form({ commandId: "queued-form", title: "Queued", form, signal: controller.signal });
		controller.abort();
		await expect(queued).rejects.toMatchObject({ code: "INTERACTION_STALE" });
		expect(port.pending()?.request.interactionId).toBe(current.request.interactionId);
		port.respond({
			kind: "interaction.respond",
			interactionId: current.request.interactionId,
			commandId: current.request.commandId,
			decision: "submit",
			value: true,
		});
		await expect(first).resolves.toBe(true);
		expect(opened.some(event => event.request.kind === "form")).toBe(false);
		expect(port.pending()).toBeUndefined();
	});
});
