import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StudioClient } from "@omp-studio/client-contract";
import type { SeanceResult } from "@omp-studio/studio-protocol";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { useI18n } from "../i18n";
import "./seance.css";

const DEMO_ANSWER =
  "演示回答 / Demo answer: the session settled on keeping the bridge typed, deferred the macOS signing work, and left one open question about retry budgets.";

/**
 * Read-only consult of a saved session (upstream `/seance`). The source is read through a
 * throwaway fork by the bundled `seance` agent; it is neither resumed nor copied.
 */
export function SeanceDialog({
  client,
  sessionId,
  source,
  title,
  preview,
  onClose,
}: {
  client?: StudioClient | undefined;
  /** Live session that runs the consult (its task tool spawns the seance agent). */
  sessionId?: string | undefined;
  /** Saved session id to consult. */
  source: string;
  title: string;
  preview: boolean;
  onClose(): void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState<SeanceResult>();
  const open = useRef(true);
  useEffect(() => () => void (open.current = false), []);
  const ready = preview || (!!client && !!sessionId);
  const ask = async () => {
    if (busy || !question.trim() || !ready) return;
    setBusy(true);
    setError("");
    setAnswer(undefined);
    try {
      let result: SeanceResult;
      if (preview) {
        result = { text: DEMO_ANSWER, sourceSessionId: source, state: "completed", model: model.trim() || "demo/model" };
      } else {
        const handle = await client!.command("seance.ask", {
          sessionId: sessionId!,
          source,
          task: question.trim(),
          ...(model.trim() ? { model: model.trim() } : {}),
        });
        // A consult is a full subagent run; it has no client-side deadline.
        result = (await waitReceipt<{ result: SeanceResult }>(client!, handle.requestId, null)).result;
      }
      if (open.current) setAnswer(result);
    } catch (cause) {
      if (open.current) setError(hostErrorMessage(cause, zh ? "只读咨询失败" : "Read-only consult failed"));
    } finally {
      if (open.current) setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <div
        className="modal seance-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "只读咨询" : "Read-only consult"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          {zh ? "只读咨询：" : "Consult (read-only): "}
          {title}
          {preview ? <span className="chip gray xs seance-demo">{zh ? "演示" : "Demo"}</span> : null}
        </div>
        <div className="modal-body seance-body">
          <p className="small muted">
            {zh
              ? "由 seance 子代理读取这段已保存会话并回答你的问题。原会话不会被恢复、不会被修改，也不会把它的内容复制到当前对话。"
              : "A seance subagent reads this saved session and answers your question. The session is not resumed, not modified, and nothing is copied into the current conversation."}
          </p>
          {!ready ? (
            <p className="small" role="status">
              {zh ? "需要一个已连接的活动会话来运行咨询。" : "A connected active session is needed to run the consult."}
            </p>
          ) : null}
          <label className="seance-field">
            {zh ? "问题" : "Question"}
            <textarea
              className="input"
              rows={4}
              maxLength={32000}
              value={question}
              disabled={busy}
              placeholder={zh ? "例如：当时为什么放弃了方案 B？" : "e.g. Why was approach B dropped?"}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <label className="seance-field">
            {zh ? "模型（可选）" : "Model (optional)"}
            <input
              className="input mono"
              value={model}
              disabled={busy}
              placeholder={zh ? "留空使用该会话保存的模型，如 @smol 或 provider/model" : "Empty uses the session's saved model; e.g. @smol or provider/model"}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          {busy ? <p className="small muted" role="status">{zh ? "正在咨询…" : "Consulting…"}</p> : null}
          {error ? <p className="small" role="alert">{error}</p> : null}
          {answer ? (
            <div className="seance-answer" role="status">
              <div className="small muted">
                {answer.state === "running"
                  ? zh
                    ? `已转为后台任务${answer.jobId ? ` ${answer.jobId}` : ""}，结果会出现在任务列表中。`
                    : `Running as background job${answer.jobId ? ` ${answer.jobId}` : ""}; the answer will appear in Jobs.`
                  : [answer.model, answer.agentId].filter(Boolean).join(" · ")}
              </div>
              <pre className="seance-text">{answer.text}</pre>
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn outline" disabled={busy} onClick={onClose}>
            {zh ? "关闭" : "Close"}
          </button>
          <button type="button" className="btn primary" disabled={busy || !ready || !question.trim()} onClick={() => void ask()}>
            {answer ? (zh ? "再问一次" : "Ask again") : zh ? "咨询" : "Consult"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
