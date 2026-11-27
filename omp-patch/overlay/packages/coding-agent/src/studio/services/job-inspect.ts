import type { AgentSession } from "../../session/agent-session";
import type { JobInspection } from "../runtime-features-protocol";
import { shortenHomePath } from "./conversation-sanitizer";
import { SessionControlError } from "./session-control-service";
import { projectJobActions } from "./job-actions";
import { taskJobProgress } from "./job-service";
import { cleanJobText, outputTail } from "./job-output";
import type { PtyInputWait } from "../../tools/bash-interactive";
import { runtimeText } from "../locale";
export * from "./job-output";

const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_PIDS = 64;

/** `jobs.inspect`: upstream `AgentSession.inspectAsyncJob`, projected to the Studio contract. */
export async function inspectStudioJob(
	session: AgentSession,
	jobId: string,
	streamId?: string,
): Promise<JobInspection> {
	const inspection = session.inspectAsyncJob(jobId);
	if (inspection === undefined) {
		throw new SessionControlError("INVALID_ARGUMENT", `Job "${jobId}" is not in this session's job tree`);
	}
	const job = session.asyncJobManager?.getJob(jobId);
	if (job) session.asyncJobManager?.widgets?.requestCaption(job);
	const caption = job && session.asyncJobManager?.widgets?.caption(job);
	const stream = streamId ? inspection.streams?.find(row => row.id === streamId) : undefined;
	if (streamId && !stream)
		throw new SessionControlError("INVALID_ARGUMENT", "This output stream is no longer available");
	const rawOutput = stream ? stream.tail() : inspection.output;
	const output = rawOutput === undefined ? "" : outputTail(cleanJobText(shortenHomePath(rawOutput)));
	const command = inspection.command === undefined ? "" : cleanJobText(inspection.command).slice(0, MAX_COMMAND_CHARS);
	const actions = job ? projectJobActions(job, true) : undefined;
	const taskSteps = job ? taskJobProgress(job).taskSteps : undefined;
	return {
		jobId,
		waitingForInput: job?.status === "running" && job.latestDetails?.pty?.waiting === true,
		...(job?.latestDetails?.pty
			? {
					inputDetection: job.latestDetails.pty.waiting === null ? ("unknown" as const) : ("known" as const),
					canInput: job.status === "running" && job.latestDetails.pty.canInput && job.process?.input !== undefined,
					inputGeneration: job.startTime,
				}
			: {}),
		...(inspection.streams?.length
			? {
					streams: inspection.streams.map(({ id, kind, producer, consumer, bytes, open, modified }) => ({
						id,
						kind,
						producer,
						consumer,
						bytes,
						open,
						modified,
					})),
				}
			: {}),
		...(stream ? { selectedStreamId: stream.id, binary: rawOutput === undefined } : {}),
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

/** Durable job metadata crosses native worker RPC; no thread-local console registry is required. */
export function readStudioPtyInputWaits(session: AgentSession): PtyInputWait[] {
	const waits: PtyInputWait[] = [];
	for (const job of session.asyncJobManager?.getRunningJobs() ?? []) {
		const pty = job.latestDetails?.pty;
		if (pty?.waiting === true && session.inspectAsyncJob(job.id))
			waits.push({
				sessionId: session.sessionId,
				toolCallId: pty.toolCallId,
				command: pty.command,
				...(pty.pid === undefined ? {} : { pid: pty.pid }),
				waiting: true,
				notify: pty.notify,
			});
	}
	return waits;
}

export async function inputStudioJob(
	session: AgentSession,
	jobId: string,
	expectedGeneration: number,
	data: string,
): Promise<{ sent: true }> {
	const inspection = session.inspectAsyncJob(jobId);
	const job = session.asyncJobManager?.getJob(jobId);
	if (
		!inspection ||
		!job ||
		job.startTime !== expectedGeneration ||
		job.status !== "running" ||
		!job.latestDetails?.pty?.canInput ||
		!job.process?.input
	)
		throw new SessionControlError(
			"COMMAND_BLOCKED",
			runtimeText(
				"PTY 已结束或所属作业已改变，请刷新后重试",
				"The PTY ended or its job changed; refresh before sending input",
			),
		);
	await job.process.input(data);
	return { sent: true };
}
