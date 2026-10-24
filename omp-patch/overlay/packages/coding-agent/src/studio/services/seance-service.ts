import type { TextContent } from "@oh-my-pi/pi-ai";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { discoverAgents } from "../../task/discovery";
import { isBundledSeance, type ResolvedSeanceSource, resolveSeanceSource } from "../../task/seance";
import { SEANCE_AGENT_NAME } from "../../task/seance-policy";
import type { RuntimeFeatureOperation, SeanceResult } from "../runtime-features-protocol";
import { SessionControlError } from "./session-control-service";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `seance.ask`: upstream `/seance` (task tool + bundled seance agent), read-only.
 * The source session is read through a fork; it is neither resumed nor copied.
 */
export async function askStudioSeance(
	session: AgentSession,
	operation: Extract<RuntimeFeatureOperation, { kind: "seance.ask" }>,
): Promise<SeanceResult> {
	const taskTool = session.agent.state.tools.find(tool => tool.name === "task");
	if (!taskTool) throw new SessionControlError("COMMAND_BLOCKED", "The task tool is not available for Seance");
	const cwd = session.sessionManager.getCwd();
	const { agents } = await discoverAgents(cwd, undefined, session.effectiveExtensionRoots);
	const seanceAgent = agents.find(agent => agent.name === SEANCE_AGENT_NAME);
	if (!seanceAgent || !isBundledSeance(seanceAgent)) {
		throw new SessionControlError(
			"COMMAND_BLOCKED",
			"A custom `seance` agent overrides the bundled one; rename it to use Seance",
		);
	}
	let source: ResolvedSeanceSource;
	try {
		source = await resolveSeanceSource(operation.source, {
			cwd,
			sessionDirHint: session.sessionManager.getSessionDir(),
			includeGlobal: true,
		});
	} catch (error) {
		throw new SessionControlError("INVALID_ARGUMENT", errorText(error));
	}
	const params: TaskParams = {
		agent: SEANCE_AGENT_NAME,
		sourceSession: source.file,
		task: operation.task,
		...(operation.model !== undefined ? { model: operation.model } : {}),
	};
	let agentId: string | undefined;
	let model: string | undefined;
	const collect = (details: TaskToolDetails | undefined): void => {
		for (const item of [...(details?.progress ?? []), ...(details?.results ?? [])]) {
			agentId = item.id;
			if (item.resolvedModel) model = item.resolvedModel;
		}
	};
	const result = await taskTool.execute(`seance-${Snowflake.next()}`, params, undefined, update => {
		collect(update.details as TaskToolDetails | undefined);
	});
	const details = result.details as TaskToolDetails | undefined;
	collect(details);
	const content = result.content
		.filter((part): part is TextContent => part.type === "text")
		.map(part => part.text)
		.join("\n")
		.trim();
	const failed = details?.results?.find(item => item.error || item.aborted || item.exitCode !== 0);
	if (
		result.isError ||
		details?.async?.state === "failed" ||
		failed ||
		(!details?.async && (details?.results?.length ?? 0) === 0)
	) {
		const message = failed?.aborted
			? failed.abortReason || content || failed.error
			: content || failed?.error || undefined;
		throw new SessionControlError("COMMAND_BLOCKED", message || "Seance failed");
	}
	const running = details?.async?.state === "running";
	const answer = running ? content : details?.results?.[0]?.output?.trim() || content;
	return {
		text: answer.slice(0, 200_000),
		sourceSessionId: source.id,
		state: running ? "running" : "completed",
		...(agentId ? { agentId } : {}),
		...(model ? { model } : {}),
		...(details?.async?.jobId ? { jobId: details.async.jobId } : {}),
	};
}
