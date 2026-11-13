import type { JobActionsFailedLog, JobActionsStep, JobActionsView } from "@omp-studio/studio-protocol";
import { Icon, type IconName } from "../icons";
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

function State({ status, conclusion, zh }: { status?: string; conclusion?: string; zh: boolean }) {
  const state = actionState(status, conclusion, zh);
  return <span className={`ji-step-state is-${state.kind}`}><Icon name={state.icon} extra="sm" /><span>{state.label}</span></span>;
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
  return <section className="ji-actions" aria-label={zh ? "GitHub Actions 步骤" : "GitHub Actions steps"}>
    <header className="ji-actions-head">
      <span className="ji-actions-title">GitHub Actions</span>
      <span className="ji-actions-repo">{view.repo}</span>
      <span className="ji-note">{stopped ? (zh ? "父 Job 已结束 · 最后一次原生观察" : "Parent job ended · Last native observation")
        : view.state === "watching" ? (zh ? "原生观察中" : "Native watch active") : zh ? "原生观察已结束" : "Native watch finished"}</span>
    </header>
    {view.note ? <p className="ji-note">{view.note}</p> : null}
    {view.runs.map(run => <div className="ji-actions-run" key={run.id}>
      <div className="ji-actions-run-head">
        <strong>{run.workflowName ?? run.displayTitle ?? (zh ? "工作流" : "Workflow")} <span className="ji-note">#{run.id}</span></strong>
        <State {...(run.status === undefined ? {} : { status: run.status })} {...(run.conclusion === undefined ? {} : { conclusion: run.conclusion })} zh={zh} />
        {run.branch ? <span className="ji-note">{run.branch}</span> : null}
      </div>
      {run.jobs.map(job => {
        const current = currentActionStep(job.steps);
        const currentState = current && actionState(current.status, current.conclusion, zh);
        const logs = view.failedLogs?.filter(log => log.runId === run.id && log.jobId === job.id) ?? [];
        return <div className="ji-actions-job" key={job.id}>
          <details>
            <summary>
              <Icon name="chevron-r" extra="sm ji-actions-chevron" />
              <span className="ji-actions-job-name">{job.name}</span>
              <State {...(job.status === undefined ? {} : { status: job.status })} {...(job.conclusion === undefined ? {} : { conclusion: job.conclusion })} zh={zh} />
              <Duration seconds={job.durationSeconds} zh={zh} />
              {current ? <span className="ji-current-step">
                <span>{currentState?.kind === "running" ? (zh ? "当前步骤" : "Current step") : currentState?.kind === "failed" ? (zh ? "失败步骤" : "Failed step") : zh ? "步骤摘要" : "Step summary"} · #{current.number}</span>
                <span>{current.name}</span>
              </span> : <span className="ji-current-step ji-note">{zh ? "原生未提供步骤" : "No native steps reported"}</span>}
            </summary>
            {job.steps.length ? <ol className="ji-steps" aria-label={zh ? `${job.name} 有序步骤` : `${job.name} ordered steps`}>
              {job.steps.map(step => <li key={step.number} value={step.number} aria-current={step.status === "in_progress" ? "step" : undefined}>
                <span className="ji-step-number">{step.number}</span>
                <span className="ji-step-name">{step.name}</span>
                <State {...(step.status === undefined ? {} : { status: step.status })} {...(step.conclusion === undefined ? {} : { conclusion: step.conclusion })} zh={zh} />
                <Duration seconds={step.durationSeconds} zh={zh} />
              </li>)}
            </ol> : <p className="ji-note">{zh ? "仅有作业状态，未提供步骤清单。" : "Only job state is available; no step list was reported."}</p>}
          </details>
          {logs.map((log, index) => <FailedLog key={`${log.runId}:${log.jobId}:${index}`} log={log} zh={zh} />)}
        </div>;
      })}
      {!run.jobs.length ? <p className="ji-note">{zh ? "等待原生工作流作业清单…" : "Waiting for native workflow jobs…"}</p> : null}
      {view.failedLogs?.filter(log => log.runId === run.id && !run.jobs.some(job => job.id === log.jobId)).map((log, index) => <FailedLog key={`${log.runId}:${log.jobName}:${index}`} log={log} zh={zh} />)}
    </div>)}
    {view.failedLogs?.filter(log => !view.runs.some(run => run.id === log.runId)).map((log, index) => <FailedLog key={`${log.runId}:${log.jobName}:${index}`} log={log} zh={zh} />)}
    {!view.runs.length ? <p className="ji-note">{zh ? "原生尚未发现工作流运行。" : "The native watcher has not found a workflow run yet."}</p> : null}
    {view.truncated ? <p className="ji-note" role="note">{zh ? "步骤或日志超出显示预算，当前仅显示原生快照的一部分。" : "Steps or logs exceeded the display budget; this is a partial native snapshot."}</p> : null}
  </section>;
}
