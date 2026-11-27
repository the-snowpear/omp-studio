import { AppSelect } from "../AppSelect";
import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  StudioClient,
  ThreadId,
} from "@omp-studio/client-contract";
import type {
  OperatorStateSnapshot,
  SessionRestoreInspection,
} from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import "./sessionRecovery.css";
export function SessionModelRecovery({
  client,
  currentSessionId,
  targetSessionId,
  threadId,
  available,
  capabilities,
  demo = false,
  onOpenModels,
}: {
  client: StudioClient;
  currentSessionId?: string | undefined;
  targetSessionId?: string | undefined;
  threadId?: ThreadId | undefined;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  demo?: boolean;
  onOpenModels: () => void;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [inspection, setInspection] = useState<SessionRestoreInspection>();
  const [fallbackModels, setFallbackModels] = useState<{ model: string; label: string }[]>([]);
  const [model, setModel] = useState("");
  const [failure, setFailure] = useState<{ step: "inspect" | "restore"; cause: unknown }>();
  const error = failure && hostErrorMessage(failure.cause, failure.step === "inspect"
    ? (zh ? "无法检查会话模型" : "Cannot inspect the saved model")
    : (zh ? "恢复未完成，请重试。" : "Restore did not complete. Try again."));
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);
  const enabled = preview
    ? demo
    : !!(
        available &&
        currentSessionId &&
        targetSessionId &&
        targetSessionId !== currentSessionId &&
        capabilities?.capabilities.some(
          (row) =>
            row.id === "session.restore.inspect" && row.grade !== "unavailable",
        )
      );
  useEffect(() => {
    const generation = ++epoch.current;
    lock.current = false;
    setInspection(undefined);
    setModel("");
    setFailure(undefined);
    setBusy(false);
    setConfirmed(false);
    setShowNotice(false);
    setFallbackModels([]);
    if (!enabled) return;
    if (preview) {
      setInspection({
        targetSessionId: "preview-saved",
        savedModels: [marks ? "demo/removed-model" : "saved/removed-model"],
        status: "missing-model",
        thinking: "high",
        alternatives: [
          { model: marks ? "demo/current-model" : "session/current-model", label: "Available model" },
        ],
        truncated: false,
      });
      return;
    }
    void (async () => {
      const handle = await client.command("session.restore.inspect", {
        sessionId: currentSessionId!,
        targetSessionId: targetSessionId!,
      });
      const result = (
        await waitReceipt<{ result: SessionRestoreInspection }>(
          client,
          handle.requestId,
        )
      ).result;
      if (generation === epoch.current) setInspection(result);
    })().catch(async (cause) => {
      if (generation !== epoch.current) return;
      setFailure({ step: "inspect", cause });
      try {
        const catalog = await client.query("models.get", {});
        if (generation !== epoch.current) return;
        setFallbackModels((catalog.availableModels ?? []).slice(0, 500).map(row => ({ model: `${row.provider}/${row.id}`, label: row.name || row.id })));
      } catch { /* Inspection can be retried from the recovery card. */ }
    });
    return () => { epoch.current++; };
  }, [client, currentSessionId, targetSessionId, enabled, preview, retry, marks]);

  const alternatives = inspection?.alternatives ?? fallbackModels;
  async function restore() {
    if (
      !enabled ||
      !confirmed ||
      lock.current ||
      !model ||
      (!preview && !threadId)
    )
      return;
    lock.current = true;
    setBusy(true);
    setFailure(undefined);
    const generation = epoch.current;
    try {
      if (preview) {
        setShowNotice(marks);
      } else {
        const handle = await client.command("session.resume", {
          threadId: threadId!,
          model,
        });
        const snapshot = await waitReceipt<OperatorStateSnapshot>(
          client,
          handle.requestId,
        );
        if (snapshot.sessionId !== targetSessionId)
          throw new Error(
            zh
              ? "恢复结果与目标会话不一致"
              : "Restored session did not match the target",
          );
      }
      if (generation === epoch.current) setConfirmed(false);
    } catch (cause) {
      if (generation === epoch.current)
        setFailure({ step: "restore", cause });
    } finally {
      if (generation === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  if (!enabled || (!error && inspection?.status !== "missing-model"))
    return null;
  return (
    <section
      className="session-model-recovery"
      aria-label={zh ? "会话模型恢复" : "Session model recovery"}
    >
      <strong>
        {inspection?.status === "missing-model"
          ? zh
            ? "保存的模型无法恢复"
            : "The saved model could not be restored"
          : zh
            ? "无法检查会话恢复条件"
            : "Session restoration could not be checked"}
        {preview && marks ? (zh ? " · 演示" : " · Demo") : ""}
      </strong>
      <p>
        {zh
          ? "当前运行的会话仍保留。选择替代模型后，才会重新打开此历史会话。"
          : "The current running session is retained. Select a replacement to reopen this saved session."}
      </p>
      {inspection?.savedModels.map((value) => (
        <span className="chip gray xs" key={value}>
          {value}
        </span>
      ))}
      {inspection?.thinking ? (
        <span className="small muted">
          {" "}
          {zh ? "保存的推理档位" : "Saved thinking level"} ·{" "}
          {inspection.thinking}
        </span>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {showNotice ? <p role="status">{zh ? "演示：已选择替代模型。" : "Demo: replacement model selected."}</p> : null}
      <div className="session-recovery-actions">
        <AppSelect
          className="select"
          aria-label={zh ? "替代模型" : "Replacement model"}
          value={model}
          disabled={busy}
          onChange={(event) => {
            setModel(event.target.value);
            setConfirmed(false);
          }}
        >
          <option value="">
            {zh ? "选择可用模型…" : "Choose an available model…"}
          </option>
          {alternatives.map((row) => (
            <option key={row.model} value={row.model}>
              {preview ? (zh ? "可用模型" : "Available model") : row.label} · {row.model}
            </option>
          ))}
        </AppSelect>
        <button
          className="btn primary"
          disabled={busy || !model || (!preview && !threadId)}
          onClick={() => setConfirmed(true)}
        >
          {zh ? "使用所选模型恢复" : "Restore with selected model"}
        </button>
        <button
          className="btn outline"
          disabled={busy}
          onClick={() => setRetry((value) => value + 1)}
        >
          {zh ? "重新检查" : "Check again"}
        </button>
        <button className="btn outline" onClick={onOpenModels}>
          {zh ? "模型配置" : "Model configuration"}
        </button>
      </div>
      {inspection?.truncated ? (
        <p className="small muted">
          {zh
            ? "仅显示前 500 个可用模型，可在模型配置中缩小范围。"
            : "Showing the first 500 available models. Narrow the catalog in model configuration."}
        </p>
      ) : null}
      {confirmed ? (
        <div
          className="session-recovery-confirm"
          role="dialog"
          aria-label={zh ? "确认替代模型" : "Confirm replacement model"}
        >
          <p>
            {zh ? "将此历史会话切换到" : "Reopen this session with"}{" "}
            <b>{model}</b>
          </p>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void restore()}
          >
            {zh ? "确认并恢复" : "Confirm and restore"}
          </button>
          <button
            className="btn outline"
            disabled={busy}
            onClick={() => setConfirmed(false)}
          >
            {zh ? "取消" : "Cancel"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
