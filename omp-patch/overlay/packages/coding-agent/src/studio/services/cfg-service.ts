import type { AgentSession } from "../../session/agent-session";
import type { StudioInteractionGateway } from "./interaction-port";
import { installStudioConfigurationApproval } from "./configuration-approval";

/** Published service entry delegates to the same native approval host as 18.8. */
export class StudioCfgService {
	#release: (() => void) | undefined;
	constructor(
		readonly session: AgentSession,
		readonly interaction: StudioInteractionGateway,
	) {
		this.rebind();
	}
	rebind(): void {
		this.#release?.();
		const tools = this.session.studioToolSession;
		if (tools && (tools.taskDepth ?? 0) === 0) tools.settingsApproval = true;
		this.#release = installStudioConfigurationApproval(this.session, this.interaction);
	}
	dispose(): void {
		this.#release?.();
		this.#release = undefined;
		const tools = this.session.studioToolSession;
		if (tools) tools.settingsApproval = false;
	}
}
