import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { JobInspection } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { JobWidget } from "./JobWidget";
import "./jobs.css";

const POLL_MS = 2000;

export type JobInspectorTarget = {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly generation: number;
};

/**
 * Inspector for one background job (`jobs.inspect`): command, cwd, live pids,
 * exit code, output tail, artifact and the full widget. Preview mode shows the
 * fixture handed in and never calls the Host.
 */
export function JobInspector({
  job,
  client,
  sessionId,
  available,
  previewInspection,
  onClose,
}: {
  job: JobInspectorTarget;
  client: StudioClient | undefined;
  sessionId: string | undefined;
  /** Live Runtime for this session; false for archived sessions or a lost Runtime. */
  available: boolean;
  /** Preview mode: the demo inspection to show instead of a Host read. */
  previewInspection?: JobInspection | null;
  onClose: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const preview = previewInspection !== undefined;
  const [inspection, setInspection] = useState<JobInspection | undefined>(undefined);
  const [error, setError] = useState("");
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (preview || !client || !sessionId || !available) return;
    const ticket = ++generation.current;
    try {
      const handle = await client.command("jobs.inspect", { sessionId, jobId: job.id });
      const result = (await waitReceipt<{ result: JobInspection }>(client, handle.requestId)).result;
      if (ticket !== generation.current) return;
      setInspection(result);
      setError("");
    } catch (cause) {
      if (ticket !== generation.current) return;
      setError(hostErrorMessage(cause, zh ? "无法读取任务详情" : "Cannot inspect this job"));
    }
  }, [preview, client, sessionId, available, job.id, zh]);

  useEffect(() => {
    setInspection(undefined);
    setError("");
    void load();
    return () => {
      generation.current += 1;
    };
    // A new generation of the same id is a different native job.
  }, [job.id, job.generation, load]);

  useEffect(() => {
    if (preview || job.status !== "running") return;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [preview, job.status, load]);

  const shown = preview ? (previewInspection ?? undefined) : inspection;
  return (
    <section
      className="job-inspector"
      aria-label={zh ? `任务详情 ${job.id}` : `Job ${job.id} details`}
      data-testid="job-inspector"
    >
      <div className="ji-head">
        <span className="ji-title" title={job.label}>{job.label}</span>
        {preview ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
        {!preview ? (
          <button className="btn small ghost" type="button" onClick={() => void load()} disabled={!available}>
            {zh ? "刷新" : "Refresh"}
          </button>
        ) : null}
        <button className="btn small ghost" type="button" onClick={onClose} aria-label={zh ? "关闭" : "Close"}>
          ×
        </button>
      </div>
      {!preview && !available ? (
        <div className="ji-note">{zh ? "Runtime 未连接或是历史会话，无法读取任务详情" : "No live Runtime for this session; job details are unavailable"}</div>
      ) : null}
      {error ? <div className="ji-error" role="alert">{error}</div> : null}
      {shown ? (
        <>
          <dl className="ji-kv">
            <dt>id</dt>
            <dd>{job.id}</dd>
            {shown.command ? (
              <>
                <dt>{zh ? "命令" : "command"}</dt>
                <dd>{shown.command}</dd>
              </>
            ) : null}
            {shown.cwd ? (
              <>
                <dt>cwd</dt>
                <dd>{shown.cwd}</dd>
              </>
            ) : null}
            <dt>pids</dt>
            <dd>{shown.pids.length ? shown.pids.join(", ") : "—"}</dd>
            {shown.exitCode !== undefined ? (
              <>
                <dt>{zh ? "退出码" : "exit"}</dt>
                <dd style={{ color: shown.exitCode === 0 ? "var(--green)" : "var(--red)" }}>{shown.exitCode}</dd>
              </>
            ) : null}
            {shown.artifactId ? (
              <>
                <dt>{zh ? "完整输出" : "artifact"}</dt>
                <dd>{shown.artifactId}</dd>
              </>
            ) : null}
          </dl>
          {shown.widget ? <JobWidget view={shown.widget} /> : null}
          {shown.output ? (
            <pre className="ji-output" aria-label={zh ? "输出尾部" : "Output tail"}>{shown.output}</pre>
          ) : (
            <div className="ji-note">{zh ? "暂无输出" : "No output yet"}</div>
          )}
        </>
      ) : !error && (preview || available) ? (
        <div className="ji-note">{preview ? (zh ? "此演示任务没有详情" : "No demo details for this job") : zh ? "读取中…" : "Loading…"}</div>
      ) : null}
    </section>
  );
}
