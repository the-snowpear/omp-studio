import { useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { TokenCountResult } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { PREVIEW_TOKEN_COUNT } from "../preview/tokenCounterPreview";
import { Icon } from "../icons";
import "./tokenCounter.css";

export function TokenCounterPane({ client }: { client: StudioClient | null }) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [text, setText] = useState("");
  const [result, setResult] = useState<TokenCountResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputVersion = useRef(0);
  return <section className="token-counter" aria-label={zh ? "离线 Token 计数" : "Offline token counter"}>
    <header className="token-counter-header"><span><Icon name="code" extra="sm" />{zh ? "离线 Token 计数" : "Offline token counter"}</span>{preview && marks ? <span className="chip xs">{zh ? "演示" : "Demo"}</span> : null}</header>
    <div className="token-counter-body">
    <p className="token-counter-help">{zh ? "仅计算输入文本，不含对话封装；使用本地 tokenizer，不发送模型请求。" : "Counts input text only, without conversation framing. Uses local tokenizers, with no model request."}</p>
    <textarea className="token-counter-input" rows={3} maxLength={262144} placeholder={zh ? "粘贴或输入要计算的文本…" : "Paste or type text to count…"} aria-label={zh ? "待计数文本" : "Text to count"} value={text} onChange={event => { inputVersion.current++; setText(event.target.value); setResult(undefined); setError(""); }} />
    <div className="token-counter-actions"><span>{!preview && !client ? (zh ? "Runtime 未连接" : "Runtime disconnected") : `${text.length.toLocaleString()} ${zh ? "字符" : "characters"}`}</span>
    <button type="button" className="btn small outline" disabled={busy || !text.length || (!preview && !client)} onClick={() => {
      if (preview) { setResult(PREVIEW_TOKEN_COUNT); return; }
      if (!client) return;
      const version = inputVersion.current; setBusy(true); setError("");
      void client.command("tokens.count", { text }).then(handle => waitReceipt<{ result: TokenCountResult }>(client, handle.requestId))
        .then(value => { if (version === inputVersion.current) setResult(value.result); })
        .catch(cause => setError(hostErrorMessage(cause, zh ? "离线计数不可用" : "Offline counting unavailable")))
        .finally(() => setBusy(false));
    }}>{busy ? (zh ? "计算中…" : "Counting…") : zh ? "计算 Token" : "Count tokens"}</button></div>
    {error ? <p role="alert" className="token-counter-error">{error}</p> : null}
    {result ? <div aria-live="polite"><p className="token-counter-help">{result.bytes} bytes · {result.chars} {zh ? "字符" : "characters"} · {result.lines} {zh ? "行" : "lines"}</p><table className="token-counter-results"><thead><tr><th scope="col">Tokenizer</th><th scope="col">Tokens</th></tr></thead><tbody>{result.encodings.map(row => <tr key={row.encoding}><td>{row.encoding}</td><td>{row.tokens}</td></tr>)}</tbody></table></div> : <p className="token-counter-empty">{zh ? "计算后可比较不同 tokenizer 的结果。" : "Compare results across tokenizers after counting."}</p>}
    </div>
  </section>;
}
