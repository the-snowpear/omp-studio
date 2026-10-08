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
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgentModelInspection>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
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
  useEffect(() => {
    const current = ++epoch.current;
    let reading = false;
    setError("");
    setData(undefined);
    if (!open || !enabled) return;
    if (preview) {
      setData(previewAgentModel(agentId, previewModel, previewSaved));
      return;
    }
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
      className="agent-model-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {zh ? "模型与思考" : "Models and thinking"}
        {preview ? (zh ? " · 演示" : " · Demo") : ""}
      </summary>
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
          <b className="tiny">{zh ? "原生候选链" : "Native candidate chain"}</b>
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
        className="btn small outline"
        disabled={!enabled}
        onClick={() => setRefresh((value) => value + 1)}
      >
        {zh ? "刷新模型详情" : "Refresh model details"}
      </button>
    </details>
  );
}
