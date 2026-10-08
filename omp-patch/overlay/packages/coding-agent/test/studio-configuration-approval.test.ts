import { afterEach, expect, test } from "bun:test";
import { cfgAdvisorEnabled, cfgAdvisorSyncBacklog } from "../src/advisor/settings";
import { Settings } from "../src/config/settings";
import { CfgProtocolHandler, setCfgApprovalHost } from "../src/internal-urls/cfg-protocol";
import { parseInternalUrl } from "../src/internal-urls/parse";
import type { AgentSession } from "../src/session/agent-session";
import { StudioRuntimeCommandArbiter } from "../src/studio/command-arbiter";
import { installStudioConfigurationApproval } from "../src/studio/services/configuration-approval";
import { StudioInteractionGateway, StudioRemoteInteractionPort } from "../src/studio/services/interaction-port";
import type { ToolSession } from "../src/tools";

afterEach(() => setCfgApprovalHost(null));
function fixture() {
	const arbiter = new StudioRuntimeCommandArbiter(
		() => ({ runtimeEpoch: 1, stateVersion: 0, isStreaming: false, isCompacting: false }),
		[],
	);
	const port = new StudioRemoteInteractionPort(
		arbiter,
		() => {},
		() => {},
	);
	const gateway = new StudioInteractionGateway();
	gateway.bind(port);
	return { port, gateway };
}
async function answer(port: StudioRemoteInteractionPort, value: "once" | "session" | undefined): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!port.pending() && Date.now() < deadline) await Bun.sleep(1);
	const request = port.pending()?.request;
	if (!request) throw new Error("Configuration approval did not arrive");
	expect(request).toMatchObject({ kind: "approval", approvalType: "configuration" });
	port.respond({
		kind: "interaction.respond",
		interactionId: request.interactionId,
		commandId: request.commandId,
		decision: value ? "submit" : "cancel",
		...(value ? { value } : {}),
	});
}
test("native cfg writes reach Studio before mutation, preserve native session grants and revoke on disposal", async () => {
	const { port, gateway } = fixture();
	const settings = Settings.isolated();
	const session = { sessionId: "s", settings } as AgentSession;
	const release = installStudioConfigurationApproval(session, gateway);
	const toolSession = {
		settings,
		settingsApproval: true,
		hasUI: true,
		taskDepth: 0,
		getSessionId: () => "s",
	} as unknown as ToolSession;
	const handler = new CfgProtocolHandler();
	try {
		const pending = handler.write(parseInternalUrl("cfg://advisor/enabled"), "true", { session: toolSession });
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
		await answer(port, "session");
		await pending;
		expect(cfgAdvisorEnabled.get(settings)).toBe(true);
		await handler.write(parseInternalUrl("cfg://advisor/syncBacklog"), '"3"', { session: toolSession });
		expect(cfgAdvisorSyncBacklog.get(settings)).toBe("3");
		expect(port.pending()).toBeUndefined();
		const save = handler.write(parseInternalUrl("cfg://advisor/syncBacklog/save"), '"5"', { session: toolSession });
		await answer(port, undefined);
		await save;
		expect(cfgAdvisorSyncBacklog.get(settings)).toBe("3");
	} finally {
		release();
	}
	await expect(
		handler.write(parseInternalUrl("cfg://advisor/enabled"), "false", { session: toolSession }),
	).rejects.toThrow("requires user approval");
});
test("expiry never approves a configuration change or cancels a different pending interaction", async () => {
	const { port } = fixture();
	const expired = port.approveConfiguration({ commandId: "cfg-1", title: "Config", details: {} }, 5);
	await expect(expired).resolves.toBe("timeout");
	expect(port.pending()).toBeUndefined();
	const other = port.confirm({ commandId: "other", title: "Other", message: "Continue?" });
	await expect(port.approveConfiguration({ commandId: "cfg-2", title: "Config", details: {} }, 5)).resolves.toBe(
		"timeout",
	);
	const request = port.pending()!.request;
	expect(request.commandId).toBe("other");
	port.respond({
		kind: "interaction.respond",
		interactionId: request.interactionId,
		commandId: request.commandId,
		decision: "cancel",
	});
	await expect(other).resolves.toBe(false);
});
