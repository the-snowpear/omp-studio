import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  StudioClient,
} from "@omp-studio/client-contract";
import type { AgentModelInspection } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewAgentModel } from "../preview/agentModelPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";
import { AppSelect } from "../AppSelect";
import "./agentModelDetails.css";
export function AgentModelDetails({
  client,
  sessionId,
  agentId,
  available,
  capabilities,
  running,
  previewModel,
  previewSaved = false,
}: {
  client?: StudioClient | undefined;
  sessionId?: string | undefined;
  agentId: string;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  running: boolean;
  previewModel?: string | undefined;
  previewSaved?: boolean;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgentModelInspection>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [changing, setChanging] = useState(false);
  const epoch = useRef(0);
  const enabled =
    preview ||
    !!(
      client &&
      sessionId &&
      available &&
      capabilities?.capabilities.some(
        (row) =>
          row.id === "agent.model.inspect" && row.grade !== "unavailable",
      )
    );
  async function change(kind: "agent.model.set" | "agent.effort.set", value: string) {
    if (!data) return;
    const current = epoch.current;
    setChanging(true); setError("");
    try {
      if (preview) {
        setData(current => current && (kind === "agent.model.set"
          ? { ...current, selectedModel: value, servingModel: value, usingFallback: false }
          : { ...current, configuredThinking: value, effectiveThinking: value === "auto" ? "high" : value }));
      } else {
        const handle = kind === "agent.model.set"
          ? await client!.command(kind, { sessionId: sessionId!, agentId, model: value })
          : await client!.command(kind, { sessionId: sessionId!, agentId, effort: value });
        const next = (await waitReceipt<{ result: AgentModelInspection }>(client!, handle.requestId)).result;
        if (current === epoch.current) setData(next);
      }
    } catch (cause) { if (current === epoch.current) setError(hostErrorMessage(cause, zh ? "模型切换失败" : "Could not change the agent model")); }
    finally { setChanging(false); }
  }
  useEffect(() => {
    const current = ++epoch.current;
    let reading = false;
    setError("");
    if (!enabled) { setData(undefined); return; }
    if (!open) return;
    if (preview) {
      setData(current => current?.agentId === agentId ? current : previewAgentModel(agentId, previewModel, previewSaved));
      return;
    }
    setData(undefined);
    async function load() {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const handle = await client!.command("agent.model.inspect", {
          sessionId: sessionId!,
          agentId,
        });
        const next = (
          await waitReceipt<{ result: AgentModelInspection }>(
            client!,
            handle.requestId,
          )
        ).result;
        if (current === epoch.current) {
          setData(next);
          setError("");
        }
      } catch (cause) {
        if (current === epoch.current)
          setError(
            hostErrorMessage(
              cause,
              zh ? "代理模型详情读取失败" : "Cannot read agent model details",
            ),
          );
      } finally {
        reading = false;
      }
    }
    void load();
    const timer = running ? setInterval(() => void load(), 3000) : undefined;
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      epoch.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    client,
    sessionId,
    agentId,
    enabled,
    open,
    preview,
    previewModel,
    previewSaved,
    running,
    refresh,
    zh,
  ]);
  return (
    <details
      className="hub-dossier-fold agent-model-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Icon name="cpu" extra="sm" />
        <span>
          {zh ? "模型与思考" : "Models and thinking"}
          {preview && marks ? (zh ? " · 演示" : " · Demo") : ""}
        </span>
        <Icon name="chevron-r" extra="sm" />
      </summary>
      <div className="hub-dossier-fold-body">
      {!enabled ? (
        <p className="tiny muted">
          {zh
            ? "此 Runtime 尚未提供代理模型详情。"
            : "This Runtime does not provide agent model details."}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {open && enabled && !data && !error ? (
        <p role="status">{zh ? "读取中…" : "Loading…"}</p>
      ) : null}
      {data ? (
        <>
          <div className="amd-tags">
          <span className="chip gray xs">
            {data.source === "live"
              ? zh
                ? "原生实时状态"
                : "Native live state"
              : data.source === "saved"
                ? zh
                  ? "已保存配置"
                  : "Saved configuration"
                : zh
                  ? "初始化中"
                  : "Starting"}
          </span>
          {data.usingFallback ? (
            <span className="chip amber xs">
              {zh ? "正在使用备用模型" : "Using a fallback model"}
            </span>
          ) : null}
          </div>
          <dl>
            <div>
              <dt>{zh ? "配置模型" : "Selected model"}</dt>
              <dd>{data.selectedModel ?? "—"}</dd>
            </div>
            <div>
              <dt>{zh ? "实际使用" : "Serving model"}</dt>
              <dd>{data.servingModel ?? (zh ? "尚未提供" : "Not reported")}</dd>
            </div>
            <div>
              <dt>{zh ? "配置思考档位" : "Configured thinking"}</dt>
              <dd>{data.configuredThinking ?? "—"}</dd>
            </div>
            <div>
              <dt>{zh ? "实际思考档位" : "Effective thinking"}</dt>
              <dd>
                {data.effectiveThinking ?? (zh ? "尚未提供" : "Not reported")}
              </dd>
            </div>
          </dl>
          {data.controllable ? <div className="amd-controls">
            <label>{zh ? "切换模型" : "Change model"}<AppSelect value={data.selectedModel ?? ""}
              disabled={changing || !data.models?.length} onChange={event => void change("agent.model.set", event.target.value)}>
              {data.selectedModel && !data.models?.some(row => row.selector === data.selectedModel) ? <option value={data.selectedModel}>{data.selectedModel}</option> : null}
              {data.models?.map(model => <option key={model.selector} value={model.selector}>{model.name} · {model.selector}</option>)}
            </AppSelect></label>
            {data.thinkingLevels?.length ? <label>{zh ? "思考档位" : "Thinking effort"}<AppSelect value={data.configuredThinking ?? data.effectiveThinking ?? "auto"}
              disabled={changing} onChange={event => void change("agent.effort.set", event.target.value)}>
              {data.thinkingLevels.map(level => <option key={level} value={level}>{level === "auto" ? zh ? "自动" : "Auto" : level === "off" ? zh ? "关闭" : "Off" : level}</option>)}
            </AppSelect></label> : null}
            <p className="tiny muted">{zh ? "立即用于此代理后续请求，保留当前任务。" : "Applies to this agent’s next request while keeping its task."}</p>
          </div> : null}
          <b className="amd-chain-title">{zh ? "原生候选链" : "Native candidate chain"}</b>
          {data.candidates ? (
            <ol>
              {data.candidates.map((model, index) => (
                <li key={index}>{model}</li>
              ))}
            </ol>
          ) : (
            <p className="tiny muted">
              {zh
                ? "原生会话尚未记录候选链。"
                : "The native session has not recorded a candidate chain."}
            </p>
          )}
          {data.candidatesTruncated ? (
            <p className="tiny muted">
              {zh
                ? "候选链较长，只显示前 16 项。"
                : "Showing the first 16 candidates."}
            </p>
          ) : null}
        </>
      ) : null}
      <button
        className="btn small ghost amd-refresh"
        type="button"
        disabled={!enabled}
        onClick={() => setRefresh((value) => value + 1)}
      >
        <Icon name="refresh" extra="sm" />
        {zh ? "刷新模型详情" : "Refresh model details"}
      </button>
      </div>
    </details>
  );
}
