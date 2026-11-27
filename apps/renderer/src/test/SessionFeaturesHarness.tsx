import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { JobInspection, RuntimeFeatureOperation, RuntimeFeatureResultMap } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { ServicesPane } from "../services/ServicesPane";
import { AgentModelDetails } from "../models/AgentModelDetails";
import { JobInspector } from "../conversation/JobInspector";
import { SessionWorktreesPane } from "../workspaces/SessionWorktreesPane";
import { PREVIEW_LEFTOVER_PROCESSES, PREVIEW_SERVICES } from "../preview/servicesPreview";
import { previewAgentModel } from "../preview/agentModelPreview";
import { PREVIEW_SESSION_WORKTREES, previewWorktreeHook } from "../preview/sessionWorktreesPreview";
import { PREVIEW_BACKGROUND_DETAILS } from "../preview/backgroundTasksPreview";
import { PtyWaitNotice, type PtyInputWait } from "../conversation/PtyWaitNotice";
import { previewPtyInputWaits } from "../preview/ptyWaitPreview";
import { CONVERSATION_REVEAL, revealConversationTarget, type ConversationRevealRequest } from "../conversation/conversationReveal";

const kinds = ["services.start", "services.leftovers.list", "services.leftovers.adopt", "services.leftovers.terminate", "agent.model.inspect", "agent.model.set", "agent.effort.set", "worktrees.session.list", "worktrees.session.hookStatus", "jobs.inspect", "jobs.input"];
const capabilities = { capabilities: kinds.map(id => ({ id, grade: "stable", version: 1, evidence: "controlled acceptance" })) } as ClientBootstrap["capabilityManifest"];
const inputGeneration = 1795760000000;
const inputInspection: JobInspection = { ...PREVIEW_BACKGROUND_DETAILS["job-82"]!, inputGeneration, canInput: true, inputDetection: "unknown", waitingForInput: false };
const controlledPtyWaits: PtyInputWait[] = [{ sessionId: "session-acceptance", sourceSessionId: "child-acceptance", ownerAgentId: "Child", jobId: "job-82", jobGeneration: inputGeneration, toolCallId: "child-pty-call", command: "npm run build | tee build.log", waiting: true, notify: false }];
type JobInput = Omit<Extract<RuntimeFeatureOperation, { kind: "jobs.input" }>, "kind">;

/** Controlled counterpart for exercising the real read/write paths without touching user processes. */
export function SessionFeaturesHarness({ visible = true }: { visible?: boolean }) {
  const { resolvedLanguage } = useI18n(), { preview } = usePreviewMode(), zh = resolvedLanguage === "zh";
  const locale = useRef(zh); locale.current = zh;
  const [tab, setTab] = useState("services");
  const [revealed, setRevealed] = useState(false);
  const [rejectInput, setRejectInput] = useState(false);
  const rejectInputRef = useRef(rejectInput); rejectInputRef.current = rejectInput;
  const [inputCalls, setInputCalls] = useState<JobInput[]>([]);
  const [holdInput, setHoldInput] = useState(false), [inputPending, setInputPending] = useState(false);
  const holdInputRef = useRef(holdInput); holdInputRef.current = holdInput;
  const releaseInput = useRef<(() => void) | null>(null);
  const ptySource = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ptySource.current;
    if (!element) return;
    const reveal = (event: Event) => {
      const request = (event as CustomEvent<ConversationRevealRequest>).detail;
      event.preventDefault();
      const found = request.toolCallId === "preview-bash-live" || request.toolCallId === "child-pty-call";
      setRevealed(found); request.finish(found);
    };
    element.addEventListener(CONVERSATION_REVEAL, reveal);
    return () => element.removeEventListener(CONVERSATION_REVEAL, reveal);
  }, []);
  const client = useMemo(() => {
    const commands: Record<string, unknown> = {}; let id = 0;
    let leftovers = [...PREVIEW_LEFTOVER_PROCESSES], services = [...PREVIEW_SERVICES], model = previewAgentModel("Child");
    return { getState: () => ({ commands }), command: async (kind: string, input: Record<string, unknown>) => {
      let result: unknown;
      if (kind === "services.list") result = { enabled: true, services };
      else if (kind === "services.leftovers.list") result = { enabled: true, reapBackground: true, leftovers };
      else if (kind === "services.leftovers.adopt") {
        const service = { ...services[0]!, name: String(input.name), instanceId: `adopted-${input.pid}`, pid: Number(input.pid), adopted: true };
        services = [...services, service]; leftovers = leftovers.filter(row => row.pid !== input.pid); result = { service };
      } else if (kind === "services.leftovers.terminate") { leftovers = leftovers.filter(row => !(input.pids as number[]).includes(row.pid)); result = { killed: 1, remaining: leftovers }; }
      else if (kind.startsWith("agent.")) {
        if (kind === "agent.model.set") model = { ...model, selectedModel: String(input.model), servingModel: String(input.model) };
        if (kind === "agent.effort.set") model = { ...model, configuredThinking: String(input.effort), effectiveThinking: String(input.effort) };
        result = model;
      } else if (kind === "jobs.inspect") result = { ...inputInspection, ...(input.streamId ? { selectedStreamId: input.streamId, output: "Build completed. Watching for changes…" } : {}) };
      else if (kind === "jobs.input") {
        const request = input as unknown as JobInput;
        setInputCalls(previous => [...previous, request]);
        if (holdInputRef.current) await new Promise<void>(resolve => { releaseInput.current = resolve; setInputPending(true); });
        if (rejectInputRef.current) throw new Error(locale.current ? "受控输入失败；草稿应保留。" : "Controlled input failure; the draft must be preserved.");
        if (request.expectedGeneration !== inputGeneration) throw new Error("Unexpected input generation in acceptance harness");
        result = { sent: true } satisfies RuntimeFeatureResultMap["jobs.input"];
      }
      else if (kind === "worktrees.session.list") result = { worktrees: PREVIEW_SESSION_WORKTREES, truncated: false };
      else if (kind === "worktrees.session.hookStatus") result = previewWorktreeHook(locale.current);
      else result = { text: "Service ready", cursor: 0, state: "running" };
      const requestId = `session-acceptance-${++id}`; commands[requestId] = { status: "completed", result: { result } }; return { requestId };
    } } as unknown as StudioClient;
  }, []);
  return <div style={{ maxWidth: 1100 }}><nav style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>{[["services", "后台进程", "Processes"], ["model", "模型热切", "Agent model"], ["job", "输出流", "Output streams"], ["worktrees", "工作树钩子", "Worktree hook"], ["pty", "终端等待输入", "Console input"]].map(([id, cn, en]) => <button className={`btn small ${tab === id ? "primary" : "outline"}`} key={id} onClick={() => setTab(id!)}>{zh ? cn : en}</button>)}</nav>
    <div hidden={tab !== "services"}><ServicesPane client={client} sessionId="session-acceptance" available capabilities={capabilities} visible={visible && tab === "services"} standalone /></div>
    <div hidden={tab !== "model"}><AgentModelDetails client={client} sessionId="session-acceptance" agentId="Child" available capabilities={capabilities} running /></div>
    <div hidden={tab !== "job"}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}><input type="checkbox" checked={rejectInput} onChange={event => setRejectInput(event.target.checked)} />{zh ? "模拟输入失败（受控客户端）" : "Reject input (controlled client)"}</label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}><input type="checkbox" checked={holdInput} onChange={event => setHoldInput(event.target.checked)} />{zh ? "延迟输入回执（受控客户端）" : "Hold input receipt (controlled client)"}</label>
      {inputPending ? <button type="button" className="btn small outline" onClick={() => { releaseInput.current?.(); releaseInput.current = null; setInputPending(false); }}>{zh ? "返回输入回执" : "Release input receipt"}</button> : null}
      <JobInspector client={client} sessionId="session-acceptance" available job={{ id: "job-82", generation: 1, label: "npm run build | tee build.log", status: "running" }} onClose={() => {}} visible={visible && tab === "job"} {...(preview ? { previewInspection: inputInspection } : {})} />
      <pre data-testid="jobs-input-calls" style={{ marginTop: 12, fontSize: 11, whiteSpace: "pre-wrap" }}>{JSON.stringify(inputCalls, null, 2)}</pre>
    </div>
    <div hidden={tab !== "worktrees"}><SessionWorktreesPane client={client} context={{ sessionId: "session-acceptance", available: true, capabilities }} visible={visible && tab === "worktrees"} /></div>
    <div hidden={tab !== "pty"}>
      <PtyWaitNotice client={client} available sessionId={preview ? "preview-session" : "session-acceptance"} waits={preview ? previewPtyInputWaits("t1") : controlledPtyWaits} onReveal={(_toolCallId, row) => revealConversationTarget(ptySource.current, { toolCallId: row.toolCallId })} />
      <div ref={ptySource}>{revealed ? <div className="convo-notice info" role="status">{zh ? "已定位对应工具调用" : "Source tool call located"} · <code>{preview ? "preview-bash-live" : "child-pty-call"}</code></div> : null}</div>
      <pre data-testid="pty-input-calls" style={{ marginTop: 12, fontSize: 11, whiteSpace: "pre-wrap" }}>{JSON.stringify(inputCalls, null, 2)}</pre>
    </div>
  </div>;
}
