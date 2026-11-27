import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { JobInspection } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { JobWidget } from "./JobWidget";
import { ActionsSteps } from "./ActionsSteps";
import { TaskStepsView } from "../agents/TaskStepsView";
import { bindTailGestures, distanceFromBottom } from "./useConversationScroll";
import { usePreviewMode } from "../preview/PreviewContext";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import "./jobs.css";
import { AppSelect } from "../AppSelect";
import { previewJobStreamOutput } from "../preview/backgroundTasksPreview";

const POLL_MS = 2000;
export type JobInspectorTarget = {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly generation: number;
};

/** One selected job. Dock visibility controls reads, not the lifetime of the job. */
export function JobInspector({ job, client, sessionId, available, previewInspection, onClose,
  visible = true, scopeKey = "", embedded = false, presentation = "details", document: ownerDocument,
}: {
  job: JobInspectorTarget;
  client: StudioClient | undefined;
  sessionId: string | undefined;
  available: boolean;
  previewInspection?: JobInspection | null;
  onClose: () => void;
  visible?: boolean;
  scopeKey?: string;
  embedded?: boolean;
  /** Process prioritizes the read-only output tail; details preserves the Agent Hub layout. */
  presentation?: "details" | "process";
  document?: Document;
}) {
  const { resolvedLanguage } = useI18n();
  const { marks } = usePreviewMode();
  const surfaceDocument = useSurfaceDocument();
  const doc = ownerDocument ?? surfaceDocument;
  const zh = resolvedLanguage === "zh";
  const inputZh = useRef(zh); inputZh.current = zh;
  const preview = previewInspection !== undefined;
  const [inspection, setInspection] = useState<JobInspection>();
  const [error, setError] = useState("");
  const [streamId, setStreamId] = useState("");
  const [input, setInput] = useState(""), [sending, setSending] = useState(false), [inputError, setInputError] = useState("");
  const [inputNotice, setInputNotice] = useState(false);
  const generation = useRef(0), inputOwner = useRef(0);
  const refresh = useRef<() => void>(() => {});
  const outputRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    inputOwner.current++;
    setInspection(undefined);
    setError("");
    setStreamId("");
    setInput(""); setSending(false); setInputError(""); setInputNotice(false);
    return () => { inputOwner.current++; };
  }, [client, sessionId, scopeKey, job.id, job.generation, preview]);

  useEffect(() => {
    const epoch = ++generation.current;
    let inFlight = false;
    let reload = false;
    let readingEpoch = 0;
    const load = async () => {
      if (preview || !client || !sessionId || !available || !visible || doc.hidden || epoch !== generation.current) return;
      if (inFlight) { reload = true; return; }
      inFlight = true;
      const observation = readingEpoch;
      try {
        const handle = await client.command("jobs.inspect", { sessionId, jobId: job.id, ...(streamId ? { streamId } : {}) });
        const result = (await waitReceipt<{ result: JobInspection }>(client, handle.requestId)).result;
        if (epoch !== generation.current || observation !== readingEpoch || doc.hidden) return;
        setInspection(result);
        setError("");
      } catch (cause) {
        if (epoch === generation.current && observation === readingEpoch && !doc.hidden) setError(hostErrorMessage(cause, zh ? "无法读取任务详情" : "Cannot inspect this job"));
      } finally {
        inFlight = false;
        if (reload && epoch === generation.current) { reload = false; void load(); }
      }
    };
    const request = () => { void load(); };
    refresh.current = request;
    request();
    // Observe the existing parent job, never start another workflow watcher.
    // Status is a dependency: a transition to terminal reads the final tail once.
    let timer: number | undefined;
    const visibilityChanged = () => {
      readingEpoch++;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (doc.hidden) return;
      request();
      if (!preview && visible && available && job.status === "running") timer = window.setInterval(request, POLL_MS);
    };
    if (!preview && visible && available && !doc.hidden && job.status === "running") timer = window.setInterval(request, POLL_MS);
    doc.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      generation.current++;
      if (timer !== undefined) clearInterval(timer);
      doc.removeEventListener("visibilitychange", visibilityChanged);
      if (refresh.current === request) refresh.current = () => {};
    };
  }, [preview, client, sessionId, scopeKey, available, visible, doc, job.id, job.generation, job.status, zh, streamId]);

  useLayoutEffect(() => {
    pinned.current = true;
    setFollowing(true);
  }, [client, sessionId, scopeKey, job.id, job.generation, preview, presentation]);
  useEffect(() => {
    const el = outputRef.current;
    return el ? bindTailGestures(el, () => pinned.current, () => {
      pinned.current = false;
      setFollowing(false);
    }) : undefined;
  }, [presentation, doc]);
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (!el || !visible || doc.hidden || !pinned.current || el.clientHeight <= 0) return;
    // The tail is a replacement snapshot, not a replay buffer. Never append it.
    // Immediate scrolling also respects reduced-motion preferences.
    el.scrollTop = el.scrollHeight;
  });

  const shown = preview ? (previewInspection ?? undefined) : inspection;
  const sendInput = async (data: string, clearDraft: boolean) => {
    if (sending || !shown?.canInput) return;
    const epoch = inputOwner.current;
    setSending(true); setInputError(""); setInputNotice(false);
    try {
      if (!preview) {
        const handle = await client!.command("jobs.input", { sessionId: sessionId!, jobId: job.id, expectedGeneration: shown.inputGeneration!, data });
        await waitReceipt(client!, handle.requestId);
      }
      if (inputOwner.current === epoch) { if (clearDraft) setInput(""); setInputNotice(true); refresh.current(); }
    } catch (cause) { if (inputOwner.current === epoch) setInputError(hostErrorMessage(cause, inputZh.current ? "未能发送终端输入" : "Could not send console input")); }
    finally { if (inputOwner.current === epoch) setSending(false); }
  };
  const terminalInput = shown?.canInput ? <form className="ji-input" onSubmit={event => { event.preventDefault(); void sendInput(input + String.fromCharCode(13), true); }}>
    <label>{zh ? "终端输入" : "Console input"}<input className="input mono" value={input} autoComplete="off" spellCheck={false} disabled={sending || !preview && !available} onChange={event => setInput(event.target.value)} /></label>
    <div className="ji-input-actions"><button className="btn small primary" type="submit" disabled={sending || !preview && !available}>{zh ? "发送并回车" : "Send + Enter"}</button><button className="btn small outline" type="button" disabled={sending || !preview && !available} onClick={() => void sendInput(String.fromCharCode(3), false)}>Ctrl+C</button></div>
    {shown.inputDetection === "unknown" ? <p className="ji-note">{zh ? "此系统无法自动判断终端是否等待输入，可在上方手动输入。" : "This system cannot detect whether the console is waiting; you can send input above."}</p> : null}
    {inputError ? <p className="ji-error" role="alert">{inputError}</p> : inputNotice ? <p className="ji-note" role="status">{preview && marks ? (zh ? "演示：输入仅在本页处理。" : "Demo: input was handled locally.") : (zh ? "输入已发送" : "Input sent")}</p> : null}
  </form> : null;
  const streamSelector = shown?.streams?.length ? <div className="ji-streams"><label>{zh ? "输出流" : "Output stream"}<AppSelect value={streamId} onChange={event => setStreamId(event.target.value)}>
    <option value="">{zh ? "标准输出" : "Command output"}</option>
    {shown.streams.map(stream => <option key={stream.id} value={stream.id}>{stream.kind === "file" ? stream.consumer : `${stream.producer} → ${stream.consumer}`} · {stream.bytes} B</option>)}
  </AppSelect></label></div> : null;
  const waiting = shown?.waitingForInput ? <p className="ji-waiting" role="status">{zh ? "终端正在等待键盘输入" : "The console is waiting for keyboard input"}</p> : null;
  const output = preview && streamId ? previewJobStreamOutput(shown?.streams?.find(stream => stream.id === streamId)?.consumer ?? streamId, zh) : shown?.output;
  const steps = shown ? <>
    {shown.actions ? <ActionsSteps view={shown.actions} zh={zh} parentStatus={job.status} /> : null}
    {shown.taskSteps ? <details className="ji-task-phases" key={`${job.id}:${job.generation}`}>
      <summary>{zh ? "原生任务提示组" : "Native task prompt groups"}</summary>
      <TaskStepsView state={shown.taskSteps} zh={zh} />
    </details> : null}
  </> : null;
  const metadata = shown ? <dl className="ji-kv">
    <dt>id</dt><dd>{job.id}</dd>
    {shown.purpose ? <><dt>{zh ? "用途" : "Purpose"}</dt><dd>{shown.purpose}</dd></> : null}
    {shown.caption ? <><dt>{zh ? "说明" : "Caption"}</dt><dd>{shown.caption}</dd></> : null}
    {shown.command && presentation === "details" ? <><dt>{zh ? "命令" : "Command"}</dt><dd>{shown.command}</dd></> : null}
    {shown.cwd ? <><dt>cwd</dt><dd>{shown.cwd}</dd></> : null}
    <dt>pids</dt><dd>{shown.pids.length ? shown.pids.join(", ") : "—"}</dd>
    {shown.exitCode !== undefined ? <><dt>{zh ? "退出码" : "Exit"}</dt><dd style={{ color: shown.exitCode === 0 ? "var(--green)" : "var(--red)" }}>{shown.exitCode}</dd></> : null}
    {shown.artifactId ? <><dt>{presentation === "process" ? (zh ? "输出产物" : "Output artifact") : (zh ? "完整输出" : "Artifact")}</dt><dd>{shown.artifactId}</dd></> : null}
  </dl> : null;
  const refreshButton = !preview ? <button className="btn small ghost" type="button" onClick={() => refresh.current()} disabled={!available || !visible}>
    {zh ? "刷新" : "Refresh"}
  </button> : null;

  if (presentation === "process") {
    const unavailable = !preview && (!available || !client || !sessionId);
    const loading = !shown && !error && !preview && !unavailable && visible;
    const note = unavailable
      ? (zh ? "Runtime 未连接或是历史会话，无法更新最近输出" : "No live Runtime for this session; recent output cannot be updated")
      : !shown && !preview
        ? (visible ? (zh ? "读取最近输出中…" : "Loading recent output…") : (zh ? "显示面板后读取最近输出" : "Recent output loads when the panel is visible"))
        : job.status === "running"
          ? (zh ? "暂无输出，等待任务写入…" : "No output yet; waiting for the job…")
          : (zh ? "此任务没有可用的最近输出" : "No recent output is available for this job");
    return (
      <section className={`job-inspector is-process${embedded ? " is-embedded" : ""}`}
        aria-label={zh ? `任务进程 ${job.id}` : `Job ${job.id} process`} data-testid="job-inspector">
        {!embedded ? <div className="ji-head">
          <span className="ji-title" data-tip={job.label}>{job.label}</span>
          <button className="btn small ghost" type="button" onClick={onClose} aria-label={zh ? "关闭" : "Close"}>×</button>
        </div> : null}
        {steps}
        {waiting}
        {terminalInput}
        {streamSelector}
        {shown?.command ? <div className="ji-process-command">
          <span>{zh ? "命令" : "Command"}</span><code>{shown.command}</code>
        </div> : null}
        <div className="ji-process-output">
          <div className="ji-process-toolbar">
            <span className="ji-process-label">{zh ? "最近输出" : "Recent output"}</span>
            {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
            <div className="ji-process-actions">
              {following ? <span className="ji-note">{zh ? "跟随输出" : "Following output"}</span>
                : <button className="btn small ghost" type="button" onClick={() => { pinned.current = true; setFollowing(true); }}>
                  {zh ? "回到最新" : "Jump to latest"}
                </button>}
              {refreshButton}
            </div>
          </div>
          <div className="ji-process-terminal" ref={outputRef} role="region" tabIndex={0}
            aria-label={zh ? "最近输出（只读）" : "Recent output (read-only)"} aria-busy={loading}
            onMouseDown={event => {
              const el = event.currentTarget;
              if (event.button !== 0 || el.scrollHeight <= el.clientHeight) return;
              const edge = el.getBoundingClientRect().right - Math.max(8, el.offsetWidth - el.clientWidth);
              // Native scrollbar dragging is an explicit reader gesture too.
              if (event.clientX >= edge) { pinned.current = false; setFollowing(false); }
            }}
            onScroll={event => {
              // Tail replacement and layout changes may decrease scrollTop; only gestures unpin.
              if (distanceFromBottom(event.currentTarget) <= 1) { pinned.current = true; setFollowing(true); }
            }}>
            {error ? <div className="ji-error" role="alert">
              {zh ? "最近输出读取失败：" : "Could not read recent output: "}{error}
              {shown?.output ? (zh ? "；保留上次读取的输出。" : "; showing the last successful read.") : null}
            </div> : null}
            {unavailable && shown?.output ? <div className="ji-note" role="status">{note}</div> : null}
            {output ? <pre className="ji-output">{output}</pre>
              : !error ? <div className="ji-note" role="status">{shown?.binary ? zh ? "二进制输出无法作为文本显示。" : "Binary output cannot be displayed as text." : note}</div> : null}
          </div>
          <div className="ji-process-limit">{zh ? "只读 · 仅末尾最多 16 KiB，非完整记录" : "Read-only · Up to the last 16 KiB, not the full log"}</div>
        </div>
        {shown ? <details className="ji-process-details" key={JSON.stringify([sessionId, scopeKey, job.id, job.generation, preview])}>
          <summary>{zh ? "任务详情" : "Job details"}</summary>
          {metadata}
        </details> : null}
        {shown?.widget ? <div className="ji-process-widget"><JobWidget view={shown.widget} /></div> : null}
      </section>
    );
  }

  return (
    <section className={`job-inspector${embedded ? " is-embedded" : ""}`}
      aria-label={zh ? `任务详情 ${job.id}` : `Job ${job.id} details`} data-testid="job-inspector">
      <div className="ji-head">
        {!embedded ? <span className="ji-title" data-tip={job.label}>{job.label}</span> : null}
        {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
        {refreshButton}
        {!embedded ? <button className="btn small ghost" type="button" onClick={onClose} aria-label={zh ? "关闭" : "Close"}>×</button> : null}
      </div>
      {!preview && !available ? <div className="ji-note">{zh ? "Runtime 未连接或是历史会话，无法读取任务详情" : "No live Runtime for this session; job details are unavailable"}</div> : null}
      {error ? <div className="ji-error" role="alert">{error}</div> : null}
      {shown ? <>
        {steps}
        {waiting}
        {terminalInput}
        {streamSelector}
        {metadata}
        {shown.widget ? <JobWidget view={shown.widget} /> : null}
        {output ? <pre className="ji-output" aria-label={zh ? "输出尾部" : "Output tail"}>{output}</pre>
          : <div className="ji-note">{shown.binary ? zh ? "二进制输出无法作为文本显示。" : "Binary output cannot be displayed as text." : zh ? "暂无输出" : "No output yet"}</div>}
      </> : !error && (preview || available) ? <div className="ji-note">
        {preview ? (marks ? (zh ? "此演示任务没有详情" : "No demo details for this job") : zh ? "没有更多详情" : "No further details") : zh ? "读取中…" : "Loading…"}
      </div> : null}
    </section>
  );
}
