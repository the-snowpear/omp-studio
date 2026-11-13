import type { GhRunWatchViewDetails } from "@oh-my-pi/pi-tui/tools/github";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../../async/job-manager";
import type {
	JobActionsFailedLog,
	JobActionsJob,
	JobActionsRun,
	JobActionsStep,
	JobActionsView,
} from "../job-actions-protocol";
import { shortenHomePath, truncateUtf8, utf8ByteLength } from "./conversation-sanitizer";
import { cleanJobText, JOB_INSPECT_OUTPUT_TAIL_BYTES, outputTail } from "./job-output";

const MAX_RUNS = 8;
const MAX_JOBS = 24;
const MAX_STEPS = 96;
const MAX_LABEL_BYTES = 240;
const MAX_URL_BYTES = 512;

/** Select the native record for this task's actual agent, not another member of a task batch. */
export function nativeJobTaskRecord(job: AsyncJob): Record<string, unknown> | undefined {
	if (job.type !== "task") return undefined;
	const id = job.agentId ?? job.id;
	const progressRows = job.latestDetails?.progress;
	const progress = Array.isArray(progressRows)
		? (progressRows.find(row => isRecord(row) && row.id === id) ??
			(progressRows.length === 1 ? progressRows[0] : undefined))
		: undefined;
	const results = job.latestDetails?.results;
	const result = Array.isArray(results)
		? (results.find(row => isRecord(row) && row.id === id) ?? (results.length === 1 ? results[0] : undefined))
		: job.latestDetails?.result;
	const settled = isRecord(result) ? result : undefined;
	const live = isRecord(progress) ? progress : undefined;
	// A settled result may omit its last stage/watch on older records. Keep only
	// this same agent's last observed native fields, with the final result winning.
	return job.status === "running" ? (live ?? settled) : settled ? { ...live, ...settled } : live;
}

/** A watch carried by the native eval job or by its task agent's structured progress/result. */
export function nativeJobActions(job: AsyncJob): GhRunWatchViewDetails | undefined {
	const raw =
		job.type === "task"
			? nativeJobTaskRecord(job)?.actions
			: job.type === "eval"
				? (job.latestDetails?.actions ?? job.latestDetails?.watch)
				: undefined;
	if (!isRecord(raw) || (raw.mode !== "run" && raw.mode !== "commit") || typeof raw.repo !== "string")
		return undefined;
	return raw as unknown as GhRunWatchViewDetails;
}

/** Project already-observed native data. This never starts a GitHub request, widget or poller. */
export function projectActionsWatch(
	watch: GhRunWatchViewDetails | undefined,
	includeLogs = false,
): JobActionsView | undefined {
	if (!watch) return undefined;
	let truncated = false;
	const text = (value: string | undefined, maxBytes = MAX_LABEL_BYTES): string | undefined => {
		if (value === undefined) return undefined;
		const clipped = truncateUtf8(cleanJobText(shortenHomePath(value)), maxBytes);
		truncated ||= clipped.truncated;
		return clipped.text;
	};
	const duration = (value: number | undefined): number | undefined =>
		value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
	const nativeRuns = watch.run ? [watch.run] : (watch.runs ?? []);
	truncated ||= nativeRuns.length > MAX_RUNS;
	let jobsLeft = MAX_JOBS;
	let stepsLeft = MAX_STEPS;
	const runs: JobActionsRun[] = nativeRuns.slice(0, MAX_RUNS).map(run => {
		const selectedJobs = run.jobs.slice(0, jobsLeft);
		truncated ||= selectedJobs.length < run.jobs.length;
		jobsLeft -= selectedJobs.length;
		const jobs: JobActionsJob[] = selectedJobs.map(job => {
			const selectedSteps = [...(job.steps ?? [])].sort((a, b) => a.number - b.number).slice(0, stepsLeft);
			truncated ||= selectedSteps.length < (job.steps?.length ?? 0);
			stepsLeft -= selectedSteps.length;
			const steps: JobActionsStep[] = selectedSteps.map(step => ({
				number: step.number,
				name: text(step.name) ?? "",
				...(step.status === undefined ? {} : { status: text(step.status)! }),
				...(step.conclusion === undefined ? {} : { conclusion: text(step.conclusion)! }),
				...(duration(step.durationSeconds) === undefined
					? {}
					: { durationSeconds: duration(step.durationSeconds)! }),
			}));
			return {
				id: job.id,
				name: text(job.name) ?? "",
				steps,
				...(job.status === undefined ? {} : { status: text(job.status)! }),
				...(job.conclusion === undefined ? {} : { conclusion: text(job.conclusion)! }),
				...(duration(job.durationSeconds) === undefined ? {} : { durationSeconds: duration(job.durationSeconds)! }),
				...(job.url === undefined ? {} : { url: text(job.url, MAX_URL_BYTES)! }),
			};
		});
		return {
			id: run.id,
			jobs,
			...(run.workflowName === undefined ? {} : { workflowName: text(run.workflowName)! }),
			...(run.displayTitle === undefined ? {} : { displayTitle: text(run.displayTitle)! }),
			...(run.status === undefined ? {} : { status: text(run.status)! }),
			...(run.conclusion === undefined ? {} : { conclusion: text(run.conclusion)! }),
			...(run.branch === undefined ? {} : { branch: text(run.branch)! }),
			...(run.headSha === undefined ? {} : { headSha: text(run.headSha)! }),
			...(run.url === undefined ? {} : { url: text(run.url, MAX_URL_BYTES)! }),
		};
	});
	let logBytesLeft = JOB_INSPECT_OUTPUT_TAIL_BYTES;
	const failedLogs: JobActionsFailedLog[] | undefined = includeLogs
		? (watch.failedLogs ?? []).slice(0, MAX_JOBS).map(log => {
				const nativeRun = nativeRuns.find(run => run.id === log.runId);
				const matches = nativeRun?.jobs.filter(job => job.name === log.jobName) ?? [];
				const rawTail = log.tail === undefined ? undefined : cleanJobText(shortenHomePath(log.tail));
				const tail = rawTail === undefined || logBytesLeft === 0 ? undefined : outputTail(rawTail, logBytesLeft);
				if (rawTail !== undefined) truncated ||= tail !== rawTail;
				logBytesLeft -= tail === undefined ? 0 : utf8ByteLength(tail);
				return {
					runId: log.runId,
					jobName: text(log.jobName) ?? "",
					available: log.available,
					...(matches.length === 1 ? { jobId: matches[0]!.id } : {}),
					...(log.workflowName === undefined ? {} : { workflowName: text(log.workflowName)! }),
					...(log.conclusion === undefined ? {} : { conclusion: text(log.conclusion)! }),
					...(tail === undefined ? {} : { tail }),
					...(log.unavailableReason === undefined ? {} : { unavailableReason: text(log.unavailableReason)! }),
				};
			})
		: undefined;
	if (includeLogs) truncated ||= (watch.failedLogs?.length ?? 0) > MAX_JOBS;
	return {
		mode: watch.mode,
		state: watch.state,
		repo: text(watch.repo) ?? "",
		runs,
		...(watch.branch === undefined ? {} : { branch: text(watch.branch)! }),
		...(watch.headSha === undefined ? {} : { headSha: text(watch.headSha)! }),
		...(watch.pollCount === undefined ? {} : { pollCount: watch.pollCount }),
		...(watch.note === undefined ? {} : { note: text(watch.note, 1024)! }),
		...(failedLogs === undefined ? {} : { failedLogs }),
		...(truncated ? { truncated: true } : {}),
	};
}

export function projectJobActions(job: AsyncJob, includeLogs = false): JobActionsView | undefined {
	return projectActionsWatch(nativeJobActions(job), includeLogs);
}
