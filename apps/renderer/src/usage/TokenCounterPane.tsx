import { useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { TokenCountResult } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { PREVIEW_TOKEN_COUNT } from "../preview/tokenCounterPreview";

export function TokenCounterPane({ client }: { client: StudioClient | null }) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [text, setText] = useState("");
  const [result, setResult] = useState<TokenCountResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputVersion = useRef(0);
  return <details style={{ borderTop: "1px solid var(--border)", padding: 12 }}>
    <summary>{zh ? "离线 Token 计数" : "Offline token counter"}{preview ? zh ? " · 演示" : " · Demo" : ""}</summary>
    <p className="small muted">{zh ? "使用 Runtime 内置 tokenizer，不发送模型请求。这里只计算输入文本，不含对话封装。" : "Uses embedded Runtime tokenizers without model requests. Counts input text only, excluding conversation framing."}</p>
    <textarea className="input mono" rows={3} style={{ width: "100%", resize: "vertical" }} maxLength={262144} aria-label={zh ? "待计数文本" : "Text to count"} value={text} onChange={event => { inputVersion.current++; setText(event.target.value); setResult(undefined); }} />
    <button className="btn small" disabled={busy || (!preview && !client)} onClick={() => {
      if (preview) { setResult(PREVIEW_TOKEN_COUNT); return; }
      if (!client) return;
      const version = inputVersion.current; setBusy(true); setError("");
      void client.command("tokens.count", { text }).then(handle => waitReceipt<{ result: TokenCountResult }>(client, handle.requestId))
        .then(value => { if (version === inputVersion.current) setResult(value.result); })
        .catch(cause => setError(hostErrorMessage(cause, zh ? "离线计数不可用" : "Offline counting unavailable")))
        .finally(() => setBusy(false));
    }}>{busy ? "…" : zh ? "计算" : "Count"}</button>
    {error ? <p role="alert" className="small">{error}</p> : null}
    {result ? <><p className="small muted">{result.bytes} bytes · {result.chars} {zh ? "字符" : "characters"} · {result.lines} {zh ? "行" : "lines"}</p><table style={{ width: "100%" }}><thead><tr><th>Tokenizer</th><th>Tokens</th></tr></thead><tbody>{result.encodings.map(row => <tr key={row.encoding}><td className="mono small">{row.encoding}</td><td className="mono" style={{ textAlign: "right" }}>{row.tokens}</td></tr>)}</tbody></table></> : null}
  </details>;
}
