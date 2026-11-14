import type { JobActionsFailedLog, JobActionsStep, JobActionsView } from "@omp-studio/studio-protocol";
import { Icon, type IconName } from "../icons";
import { StepNode, StepRail, StepRailItem, type StepTone } from "./StepRail";
import "./jobs.css";

type ActionState = { kind: "running" | "pending" | "success" | "failed" | "cancelled" | "skipped" | "unknown"; icon: IconName; label: string };

export function actionState(status: string | undefined, conclusion: string | undefined, zh: boolean): ActionState {
  if (conclusion === "skipped") return { kind: "skipped", icon: "chevron-r", label: zh ? "已跳过" : "Skipped" };
  if (conclusion === "cancelled") return { kind: "cancelled", icon: "x", label: zh ? "已取消" : "Cancelled" };
  if (conclusion === "success" || conclusion === "neutral") return { kind: "success", icon: "check", label: conclusion === "neutral" ? (zh ? "中性结果" : "Neutral") : zh ? "成功" : "Success" };
  if (["failure", "timed_out", "action_required", "startup_failure"].includes(conclusion ?? "")) {
    return { kind: "failed", icon: conclusion === "action_required" ? "alert" : "x", label: conclusion === "timed_out" ? (zh ? "已超时" : "Timed out") : conclusion === "action_required" ? (zh ? "需要操作" : "Action required") : zh ? "失败" : "Failed" };
  }
  if (status === "in_progress") return { kind: "running", icon: "play", label: zh ? "运行中" : "Running" };
  if (["queued", "requested", "waiting", "pending"].includes(status ?? "")) return { kind: "pending", icon: "clock", label: zh ? "等待中" : "Pending" };
  if (status === "completed") return { kind: "unknown", icon: "check", label: zh ? "已结束，结果未知" : "Finished, result unknown" };
  return { kind: "unknown", icon: "clock", label: status || conclusion || (zh ? "状态未知" : "Unknown state") };
}

const TONES: Record<ActionState["kind"], StepTone> = {
  running: "active", pending: "pending", success: "done", failed: "failed", cancelled: "muted", skipped: "muted", unknown: "muted",
};

function State({ status, conclusion, zh, pill }: { status?: string | undefined; conclusion?: string | undefined; zh: boolean; pill?: boolean }) {
  const state = actionState(status, conclusion, zh);
  return <span className={`ji-step-state is-${state.kind}${pill ? " is-pill" : ""}`}>{pill ? <Icon name={state.icon} extra="sm" /> : null}<span>{state.label}</span></span>;
}

function Duration({ seconds, zh }: { seconds: number | undefined; zh: boolean }) {
  return seconds === undefined
    ? <span className="ji-step-duration is-unknown">{zh ? "耗时未知" : "Duration unknown"}</span>
    : <time className="ji-step-duration" dateTime={`PT${seconds}S`}>{seconds.toLocaleString()}s</time>;
}

export function currentActionStep(steps: readonly JobActionsStep[]): JobActionsStep | undefined {
  return steps.find(step => step.status === "in_progress")
    ?? steps.find(step => actionState(step.status, step.conclusion, false).kind === "failed")
    ?? steps.find(step => actionState(step.status, step.conclusion, false).kind === "pending")
    ?? steps.at(-1);
}

function FailedLog({ log, zh }: { log: JobActionsFailedLog; zh: boolean }) {
  return <details className="ji-actions-log">
    <summary><Icon name="terminal" extra="sm" />{zh ? "日志" : "Log"} · {log.jobName} · #{log.runId}</summary>
    {log.available && log.tail ? <pre className="ji-output">{log.tail}</pre>
      : <p className="ji-note">{log.unavailableReason ?? (zh ? "原生未提供日志尾部" : "No native log tail available")}</p>}
  </details>;
}

/** One ordered step renderer, shared by both inspector presentations and native tool results. */
export function ActionsSteps({ view, zh, parentStatus }: { view: JobActionsView; zh: boolean; parentStatus?: string }) {
  const stopped = parentStatus !== undefined && parentStatus !== "running" && parentStatus !== "queued" && view.state === "watching";
  const live = !stopped && view.state === "watching";
  return <section className="ji-actions" aria-label={zh ? "GitHub Actions 步骤" : "GitHub Actions steps"}>
    <header className="ji-actions-head">
      <span className="ji-actions-title"><Icon name="github" extra="sm" />GitHub Actions</span>
      <span className="ji-actions-repo">{view.repo}</span>
      <span className={`ji-actions-watch${live ? " is-live" : ""}`}>{stopped ? (zh ? "父 Job 已结束 · 最后一次原生观察" : "Parent job ended · Last native observation")
        : view.state === "watching" ? (zh ? "原生观察中" : "Native watch active") : zh ? "原生观察已结束" : "Native watch finished"}</span>
    </header>
    {view.note ? <p className="ji-note">{view.note}</p> : null}
    {view.runs.map(run => <div className="ji-actions-run" key={run.id}>
      <div className="ji-actions-run-head">
        <strong>{run.workflowName ?? run.displayTitle ?? (zh ? "工作流" : "Workflow")}</strong>
        <span className="ji-actions-run-id">#{run.id}</span>
        {run.branch ? <span className="ji-actions-branch"><Icon name="branch" extra="sm" />{run.branch}</span> : null}
        <State status={run.status} conclusion={run.conclusion} zh={zh} pill />
      </div>
      {run.jobs.length ? <ul className="ji-actions-jobs">{run.jobs.map(job => {
        const current = currentActionStep(job.steps);
        const currentState = current && actionState(current.status, current.conclusion, zh);
        const jobState = actionState(job.status, job.conclusion, zh);
        const logs = view.failedLogs?.filter(log => log.runId === run.id && log.jobId === job.id) ?? [];
        return <li className={`ji-actions-job is-${jobState.kind}`} key={job.id}>
          <details>
            <summary>
              <StepNode tone={TONES[jobState.kind]} icon={jobState.kind === "running" ? "play" : undefined} />
              <span className="ji-actions-job-main">
                <span className="ji-actions-job-name">{job.name}</span>
                {current ? <span className="ji-current-step">
                  <span>{currentState?.kind === "running" ? (zh ? "当前步骤" : "Current step") : currentState?.kind === "failed" ? (zh ? "失败步骤" : "Failed step") : zh ? "步骤摘要" : "Step summary"} · #{current.number}</span>
                  <span className="ji-current-step-name">{current.name}</span>
                </span> : <span className="ji-current-step ji-note">{zh ? "原生未提供步骤" : "No native steps reported"}</span>}
              </span>
              <span className="ji-actions-job-meta">
                <State status={job.status} conclusion={job.conclusion} zh={zh} />
                <Duration seconds={job.durationSeconds} zh={zh} />
              </span>
              <Icon name="chevron-r" extra="sm ji-actions-chevron" />
            </summary>
            {job.steps.length ? <StepRail className="ji-steps" aria-label={zh ? `${job.name} 有序步骤` : `${job.name} ordered steps`}>
              {job.steps.map(step => {
                const state = actionState(step.status, step.conclusion, zh);
                return <StepRailItem key={step.number} value={step.number} tone={TONES[state.kind]} current={step.status === "in_progress"}
                  node={<StepNode tone={TONES[state.kind]} label={step.number} icon={state.kind === "running" ? "play" : state.kind === "skipped" ? "chevron-r" : state.kind === "cancelled" ? "x" : undefined} />}>
                  <span className="ji-step-row">
                    <span className="ji-step-name">{step.name}</span>
                    <State status={step.status} conclusion={step.conclusion} zh={zh} />
                    <Duration seconds={step.durationSeconds} zh={zh} />
                  </span>
                </StepRailItem>;
              })}
            </StepRail> : <p className="ji-note ji-steps-empty">{zh ? "仅有作业状态，未提供步骤清单。" : "Only job state is available; no step list was reported."}</p>}
          </details>
          {logs.map((log, index) => <FailedLog key={`${log.runId}:${log.jobId}:${index}`} log={log} zh={zh} />)}
        </li>;
      })}</ul> : <p className="ji-note">{zh ? "等待原生工作流作业清单…" : "Waiting for native workflow jobs…"}</p>}
      {view.failedLogs?.filter(log => log.runId === run.id && !run.jobs.some(job => job.id === log.jobId)).map((log, index) => <FailedLog key={`${log.runId}:${log.jobName}:${index}`} log={log} zh={zh} />)}
    </div>)}
    {view.failedLogs?.filter(log => !view.runs.some(run => run.id === log.runId)).map((log, index) => <FailedLog key={`${log.runId}:${log.jobName}:${index}`} log={log} zh={zh} />)}
    {!view.runs.length ? <p className="ji-note">{zh ? "原生尚未发现工作流运行。" : "The native watcher has not found a workflow run yet."}</p> : null}
    {view.truncated ? <p className="ji-note" role="note">{zh ? "步骤或日志超出显示预算，当前仅显示原生快照的一部分。" : "Steps or logs exceeded the display budget; this is a partial native snapshot."}</p> : null}
  </section>;
}
