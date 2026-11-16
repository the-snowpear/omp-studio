import type { JsonValue } from "@omp-studio/client-contract";
import type { JobActionsFailedLog, JobActionsJob, JobActionsRun, JobActionsStep, JobActionsView } from "@omp-studio/studio-protocol";
import { jsonRecord, jsonString } from "./conversationViewModel";

const MAX_RUNS = 8;
const MAX_JOBS = 24;
const MAX_STEPS = 96;

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Read only structured native watch metadata from a tool result, never args or ANSI output. */
export function actionsViewFromData(value: JsonValue | undefined): JobActionsView | undefined {
  const watch = jsonRecord(value);
  if (!watch || (watch.mode !== "run" && watch.mode !== "commit")) return undefined;
  const repo = jsonString(watch.repo);
  if (repo === undefined) return undefined;
  const nativeRuns = watch.run ? [watch.run] : Array.isArray(watch.runs) ? watch.runs : [];
  let truncated = watch.truncated === true || nativeRuns.length > MAX_RUNS;
  let jobsLeft = MAX_JOBS;
  let stepsLeft = MAX_STEPS;
  const runs: JobActionsRun[] = [];
  for (const entry of nativeRuns.slice(0, MAX_RUNS)) {
    const run = jsonRecord(entry);
    const id = number(run?.id);
    if (!run || id === undefined) continue;
    const nativeJobs = Array.isArray(run.jobs) ? run.jobs : [];
    const selectedJobs = nativeJobs.slice(0, jobsLeft);
    truncated ||= selectedJobs.length < nativeJobs.length;
    jobsLeft -= selectedJobs.length;
    const jobs: JobActionsJob[] = [];
    for (const item of selectedJobs) {
      const job = jsonRecord(item);
      const jobId = number(job?.id);
      const name = jsonString(job?.name);
      if (!job || jobId === undefined || name === undefined) continue;
      const nativeSteps = Array.isArray(job.steps) ? job.steps : [];
      const selectedSteps = nativeSteps.slice(0, stepsLeft);
      truncated ||= selectedSteps.length < nativeSteps.length;
      stepsLeft -= selectedSteps.length;
      const steps: JobActionsStep[] = [];
      for (const stepEntry of selectedSteps) {
        const step = jsonRecord(stepEntry);
        const stepNumber = number(step?.number);
        const stepName = jsonString(step?.name);
        if (!step || stepNumber === undefined || stepName === undefined) continue;
        steps.push({ number: stepNumber, name: stepName,
          ...(jsonString(step.status) === undefined ? {} : { status: jsonString(step.status)! }),
          ...(jsonString(step.conclusion) === undefined ? {} : { conclusion: jsonString(step.conclusion)! }),
          ...(number(step.durationSeconds) === undefined ? {} : { durationSeconds: number(step.durationSeconds)! }),
        });
      }
      steps.sort((a, b) => a.number - b.number);
      jobs.push({ id: jobId, name, steps,
        ...(jsonString(job.status) === undefined ? {} : { status: jsonString(job.status)! }),
        ...(jsonString(job.conclusion) === undefined ? {} : { conclusion: jsonString(job.conclusion)! }),
        ...(number(job.durationSeconds) === undefined ? {} : { durationSeconds: number(job.durationSeconds)! }),
        ...(jsonString(job.url) === undefined ? {} : { url: jsonString(job.url)! }),
      });
    }
    runs.push({ id, jobs,
      ...(jsonString(run.workflowName) === undefined ? {} : { workflowName: jsonString(run.workflowName)! }),
      ...(jsonString(run.displayTitle) === undefined ? {} : { displayTitle: jsonString(run.displayTitle)! }),
      ...(jsonString(run.status) === undefined ? {} : { status: jsonString(run.status)! }),
      ...(jsonString(run.conclusion) === undefined ? {} : { conclusion: jsonString(run.conclusion)! }),
      ...(jsonString(run.branch) === undefined ? {} : { branch: jsonString(run.branch)! }),
      ...(jsonString(run.headSha) === undefined ? {} : { headSha: jsonString(run.headSha)! }),
      ...(jsonString(run.url) === undefined ? {} : { url: jsonString(run.url)! }),
    });
  }
  let logCharsLeft = 16 * 1024;
  const failedLogs: JobActionsFailedLog[] = [];
  const nativeLogs = Array.isArray(watch.failedLogs) ? watch.failedLogs : [];
  truncated ||= nativeLogs.length > MAX_JOBS;
  for (const entry of nativeLogs.slice(0, MAX_JOBS)) {
    const log = jsonRecord(entry);
    const runId = number(log?.runId);
    const jobName = jsonString(log?.jobName);
    if (!log || runId === undefined || jobName === undefined) continue;
    const rawTail = jsonString(log.tail);
    const tail = rawTail === undefined || logCharsLeft === 0 ? undefined : rawTail.slice(-logCharsLeft);
    truncated ||= rawTail !== undefined && tail !== rawTail;
    logCharsLeft -= tail?.length ?? 0;
    const matches = runs.find(run => run.id === runId)?.jobs.filter(job => job.name === jobName) ?? [];
    const jobId = number(log.jobId) ?? (matches.length === 1 ? matches[0]!.id : undefined);
    failedLogs.push({ runId, jobName, available: log.available === true,
      ...(jobId === undefined ? {} : { jobId }),
      ...(jsonString(log.workflowName) === undefined ? {} : { workflowName: jsonString(log.workflowName)! }),
      ...(jsonString(log.conclusion) === undefined ? {} : { conclusion: jsonString(log.conclusion)! }),
      ...(tail === undefined ? {} : { tail }),
      ...(jsonString(log.unavailableReason) === undefined ? {} : { unavailableReason: jsonString(log.unavailableReason)! }),
    });
  }
  return { mode: watch.mode, state: watch.state === "completed" ? "completed" : "watching", repo, runs,
    ...(jsonString(watch.branch) === undefined ? {} : { branch: jsonString(watch.branch)! }),
    ...(jsonString(watch.headSha) === undefined ? {} : { headSha: jsonString(watch.headSha)! }),
    ...(jsonString(watch.note) === undefined ? {} : { note: jsonString(watch.note)! }),
    ...(number(watch.pollCount) === undefined ? {} : { pollCount: number(watch.pollCount)! }),
    ...(failedLogs.length ? { failedLogs } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}
