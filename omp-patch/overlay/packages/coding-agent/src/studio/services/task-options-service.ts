import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { formatModelStringWithRouting } from "../../config/model-resolver";
import type { AgentSession } from "../../session/agent-session";
import { discoverAgents } from "../../task/discovery";
import { assertPerCallModelApproved, parentModelGrantPattern, PerCallModelError } from "../../task/model-approval";
import { cfgTaskFile, cfgTaskMaxEffort, perCallModelEnabled } from "../../task/settings";
import { SessionControlError } from "./session-control-service";

/** The same grants used by task dispatch, including project narrowing and exact selector rules. */
export async function readStudioTaskOptions(session: AgentSession, definition: string) {
	const discovery = await discoverAgents(session.sessionManager.getCwd(), undefined, session.effectiveExtensionRoots);
	const agent = [...discovery.agents, ...(session.studioToolSession?.getSessionAgents?.() ?? [])].find(
		row => row.name === definition,
	);
	if (!agent)
		throw new SessionControlError("INVALID_ARGUMENT", "The selected agent definition is no longer available");
	const allowed = perCallModelEnabled(session.settings, "task");
	const grants = {
		settings: session.settings,
		agentName: agent.name,
		agentSource: agent.source,
		agentModel: agent.model,
		parentModelPattern: session.model ? parentModelGrantPattern(session.model) : undefined,
	};
	const models = allowed
		? session.modelRegistry
				.getAvailable("chat")
				.filter(model => {
					try {
						assertPerCallModelApproved(model, grants, session.modelRegistry);
						return true;
					} catch (error) {
						if (error instanceof PerCallModelError) return false;
						throw error;
					}
				})
				.map(model => ({
					selector: formatModelStringWithRouting(model),
					name: model.name,
					thinkingLevels: getSupportedEfforts(model),
				}))
		: [];
	return {
		fileEnabled: cfgTaskFile.get(session.settings),
		modelSelection: allowed,
		maxEffort: cfgTaskMaxEffort.get(session.settings),
		models,
	};
}
