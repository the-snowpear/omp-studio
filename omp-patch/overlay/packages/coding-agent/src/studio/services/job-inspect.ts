import type { AgentSession } from "../../session/agent-session";
import type { JobInspection } from "../runtime-features-protocol";
import { shortenHomePath } from "./conversation-sanitizer";
import { SessionControlError } from "./session-control-service";
import { projectJobActions } from "./job-actions";
import { taskJobProgress } from "./job-service";
import { cleanJobText, outputTail } from "./job-output";
export * from "./job-output";

const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_PIDS = 64;

/** `jobs.inspect`: upstream `AgentSession.inspectAsyncJob`, projected to the Studio contract. */
export async function inspectStudioJob(session: AgentSession, jobId: string): Promise<JobInspection> {
	const inspection = session.inspectAsyncJob(jobId);
	if (inspection === undefined) {
		throw new SessionControlError("INVALID_ARGUMENT", `Job "${jobId}" is not in this session's job tree`);
	}
	const job = session.asyncJobManager?.getJob(jobId);
	if (job) session.asyncJobManager?.widgets?.requestCaption(job);
	const caption = job && session.asyncJobManager?.widgets?.caption(job);
	const output = inspection.output === undefined ? "" : outputTail(cleanJobText(shortenHomePath(inspection.output)));
	const command = inspection.command === undefined ? "" : cleanJobText(inspection.command).slice(0, MAX_COMMAND_CHARS);
	const actions = job ? projectJobActions(job, true) : undefined;
	const taskSteps = job ? taskJobProgress(job).taskSteps : undefined;
	return {
		jobId,
		...(job?.intent ? { purpose: cleanJobText(job.intent) } : {}),
		...(caption ? { caption: cleanJobText(caption) } : {}),
		...(command ? { command } : {}),
		...(inspection.cwd ? { cwd: shortenHomePath(inspection.cwd) } : {}),
		pids: inspection.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, MAX_PIDS),
		...(typeof inspection.exitCode === "number" && Number.isFinite(inspection.exitCode)
			? { exitCode: inspection.exitCode }
			: {}),
		...(output ? { output } : {}),
		...(inspection.artifactId ? { artifactId: inspection.artifactId } : {}),
		...(inspection.widget ? { widget: inspection.widget } : {}),
		...(actions ? { actions } : {}),
		...(taskSteps ? { taskSteps } : {}),
	};
}
