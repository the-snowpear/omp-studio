import { inspectAgyInstallation } from "@oh-my-pi/pi-ai/providers/antigravity-cli/binary";
import { isAntigravityMcpConfigured } from "@oh-my-pi/pi-ai/providers/antigravity-cli/host";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { ModelAntigravityReadiness } from "../model-services-protocol";
import { SessionControlError } from "./session-control-service";

/** Reading readiness must not install a binary, refresh OAuth, or accept a provider warning. */
export async function inspectStudioAntigravity(
	session: AgentSession,
	sessionId: string,
): Promise<ModelAntigravityReadiness> {
	if (sessionId !== session.sessionId) throw new SessionControlError("COMMAND_BLOCKED", "The model session changed");
	const authenticated = session.modelRegistry.authStorage.keys.source("antigravity-cli") !== undefined;
	const bridgeReady = isAntigravityMcpConfigured();
	try {
		const installation = await inspectAgyInstallation();
		return {
			providerId: "antigravity-cli",
			...installation,
			authenticated,
			bridgeReady,
			status: !installation.installed
				? "not-installed"
				: !authenticated
					? "not-authenticated"
					: !bridgeReady
						? "bridge-unavailable"
						: "ready",
		};
	} catch (error) {
		return {
			providerId: "antigravity-cli",
			installed: false,
			authenticated,
			bridgeReady,
			status: "error",
			error: sanitizeText(error instanceof Error ? error.message : String(error)).slice(0, 1000),
		};
	}
}
