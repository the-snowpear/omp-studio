import type { AgentSession } from "../../session/agent-session";
import { clearApprovalGrants } from "../../tools/approval-cache";
import {
	type RuntimeFeatureOperation,
	validateRuntimeFeatureOperation,
	validateRuntimeFeatureResult,
} from "../runtime-features-protocol";
import { inspectStudioJob } from "./job-inspect";
import { StudioMcpAuthService } from "./mcp-auth-service";
import { askStudioSeance } from "./seance-service";
import { SessionControlError } from "./session-control-service";

/** OMP 18.11–18.12 features: remembered approvals, job inspection, MCP auth and Seance. */
export class StudioRuntimeFeatureService {
	readonly mcpAuth: StudioMcpAuthService;

	constructor(readonly session: AgentSession) {
		this.mcpAuth = new StudioMcpAuthService(session);
	}

	async execute(operation: RuntimeFeatureOperation): Promise<unknown> {
		validateRuntimeFeatureOperation(operation);
		if (operation.sessionId !== this.session.sessionId) {
			throw new SessionControlError("INVALID_ARGUMENT", "The operation targets another session");
		}
		const result = await this.#run(operation);
		validateRuntimeFeatureResult(operation.kind, result);
		return result;
	}

	async #run(operation: RuntimeFeatureOperation): Promise<unknown> {
		switch (operation.kind) {
			case "approvals.forget":
				// Same effect as `/forget-approvals`: the approval-cache DB and every session's store.
				clearApprovalGrants(this.session.settings.getAgentDir());
				return { cleared: true };
			case "jobs.inspect":
				return inspectStudioJob(this.session, operation.jobId);
			case "mcp.auth.reauth":
				return this.mcpAuth.reauth(operation.name);
			case "mcp.auth.unauth":
				return this.mcpAuth.unauth(operation.name);
			case "mcp.auth.reconnect":
				return this.mcpAuth.reconnect(operation.name);
			case "seance.ask":
				return askStudioSeance(this.session, operation);
		}
	}
}
