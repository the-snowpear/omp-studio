import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ContextCategoryId, ContextEntrySummary, ContextViewIndex } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_CONTEXT_VIEW, previewContextEntries, previewContextText } from "../preview/contextViewPreview";
import { hostErrorMessage } from "../hostError";
import "./contextInspector.css";

const LABELS: Record<ContextCategoryId, string> = { "system-prompt": "系统提示词", skills: "技能目录", "built-in-tools": "内置工具", "custom-tools": "自定义工具", "user-messages": "用户与开发者消息", "assistant-messages": "助手消息", "assistant-thinking": "助手推理", "tool-calls": "工具调用", "tool-output": "工具输出" };
export function ContextInspector({ client, sessionId, visible, onClose }: { client: StudioClient; sessionId?: string | undefined; visible: boolean; onClose(): void }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [index, setIndex] = useState<ContextViewIndex>(); const [category, setCategory] = useState<ContextCategoryId>("system-prompt");
  const [entries, setEntries] = useState<ContextEntrySummary[]>([]); const [search, setSearch] = useState(""); const [nextOffset, setNextOffset] = useState<number>();
  const [selected, setSelected] = useState<ContextEntrySummary>(); const [body, setBody] = useState(""); const [nextBody, setNextBody] = useState<number>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const epoch = useRef(0); const bodyGeneration = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current; setIndex(undefined); setEntries([]); setSelected(undefined); setBody(""); setError(""); setCategory("system-prompt"); setSearch("");
    if (!visible) return;
    let acquired: ContextViewIndex | undefined;
    if (preview) { setIndex(PREVIEW_CONTEXT_VIEW); return; }
    if (!sessionId) { setError(zh ? "没有可查看的活动会话。" : "No active session to inspect."); return; }
    setBusy(true);
    void client.query("context.view.open", { sessionId }).then(result => {
      acquired = result;
      if (generation === epoch.current) setIndex(result);
      else void client.query("context.view.release", { sessionId: result.sessionId, snapshotId: result.snapshotId }).catch(() => {});
    }).catch(cause => { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "上下文不可用" : "Context unavailable")); }).finally(() => { if (generation === epoch.current) setBusy(false); });
    return () => { epoch.current++; bodyGeneration.current++; if (acquired) void client.query("context.view.release", { sessionId: acquired.sessionId, snapshotId: acquired.snapshotId }).catch(() => {}); };
  }, [visible, preview, sessionId, client, zh]);
  useEffect(() => {
    if (!index || !visible) return;
    const generation = ++bodyGeneration.current; setSelected(undefined); setBody(""); setNextBody(undefined); setBusy(true); setError("");
    const timer = setTimeout(() => {
      if (preview) { const rows = previewContextEntries(category); setEntries(rows.filter(row => row.label.toLowerCase().includes(search.toLowerCase()))); setNextOffset(undefined); setBusy(false); return; }
      void client.query("context.view.list", { sessionId: index.sessionId, snapshotId: index.snapshotId, category, search }).then(page => { if (generation === bodyGeneration.current) { setEntries(page.entries); setNextOffset(page.nextOffset); } }).catch(cause => { if (generation === bodyGeneration.current) setError(hostErrorMessage(cause, "Context read failed")); }).finally(() => { if (generation === bodyGeneration.current) setBusy(false); });
    }, 150);
    return () => { clearTimeout(timer); bodyGeneration.current++; };
  }, [index, category, search, visible, preview, client]);
  useEffect(() => { if (!visible) return; const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [visible, onClose]);
  const read = async (entry: ContextEntrySummary, append = false) => {
    if (!index || busy) return; const generation = ++bodyGeneration.current; setBusy(true); setError(""); setSelected(entry); if (!append) setBody("");
    try {
      const result = preview ? { text: previewContextText(category), nextOffset: undefined } : await client.query("context.view.entry", { sessionId: index.sessionId, snapshotId: index.snapshotId, entryId: entry.id, ...(append && nextBody !== undefined ? { offset: nextBody } : {}) });
      if (generation === bodyGeneration.current) { setBody(previous => append ? previous + result.text : result.text); setNextBody(result.nextOffset); }
    } catch (cause) { if (generation === bodyGeneration.current) setError(hostErrorMessage(cause, "Context entry failed")); }
    finally { if (generation === bodyGeneration.current) setBusy(false); }
  };
  const more = async () => {
    if (!index || nextOffset === undefined || busy) return; const generation = bodyGeneration.current; setBusy(true);
    try { const page = await client.query("context.view.list", { sessionId: index.sessionId, snapshotId: index.snapshotId, category, search, offset: nextOffset }); if (generation === bodyGeneration.current) { setEntries(previous => [...previous, ...page.entries]); setNextOffset(page.nextOffset); } }
    catch (cause) { if (generation === bodyGeneration.current) setError(hostErrorMessage(cause, "Context page failed")); }
    finally { if (generation === bodyGeneration.current) setBusy(false); }
  };
  if (!visible) return null;
  return <div className="context-inspector-backdrop"><section className="context-inspector" role="dialog" aria-modal="true" aria-label={zh ? "上下文查看器" : "Context viewer"}>
    <header><div><h2>{zh ? "上下文查看器" : "Context viewer"}{preview ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}</h2><p className="muted">{zh ? "打开时的只读快照；token 为原生估算，不是账单。关闭后释放，不实时重算。" : "Read-only snapshot at open. Native token estimates, not billing; released on close."}</p></div><button autoFocus className="btn small ghost" onClick={onClose}>{zh ? "关闭" : "Close"}</button></header>
    {index ? <p className="context-inspector-summary">{zh ? "上下文" : "Context"} {index.usedTokens.toLocaleString()} / {index.contextWindow.toLocaleString()} · {zh ? "空余" : "Free"} {index.freeTokens.toLocaleString()} · {zh ? "压缩阈值" : "Compaction threshold"} {index.thresholdTokens?.toLocaleString() ?? "—"} · {zh ? "本地压缩节省" : "Local compression savings"} {index.savedTokens.toLocaleString()}{index.truncated ? " · bounded preview" : ""}</p> : null}
    <div className="context-inspector-controls"><AppSelect className="select" aria-label={zh ? "上下文类别" : "Context category"} value={category} disabled={!index} onChange={event => setCategory(event.target.value as ContextCategoryId)}>{(index?.categories ?? []).map(row => <option key={row.id} value={row.id}>{zh ? LABELS[row.id] : row.label} · {row.tokens.toLocaleString()} tokens</option>)}</AppSelect><input className="input" aria-label={zh ? "筛选上下文" : "Filter context"} placeholder={zh ? "筛选名称或正文" : "Filter labels or content"} value={search} disabled={!index} onChange={event => setSearch(event.target.value)} /></div>
    {error ? <p role="alert">{error}</p> : null}{busy ? <p role="status">{zh ? "正在读取…" : "Loading…"}</p> : null}
    <div className="context-inspector-split"><aside><ul>{entries.map(entry => <li key={entry.id}><button className={`context-entry${selected?.id === entry.id ? " active" : ""}`} disabled={busy} onClick={() => void read(entry)}><strong>{entry.label}</strong><span>{entry.tokens.toLocaleString()} tokens · {entry.bytes.toLocaleString()} B</span>{entry.info ? <small>{entry.info}</small> : null}</button></li>)}</ul>{!entries.length && !busy ? <p className="muted">{category === "skills" ? zh ? "技能目录权重已计入系统提示词，原生没有独立正文。" : "Skill-list weight is part of the prompt; no separate body." : zh ? "没有匹配条目" : "No matching entries"}</p> : null}{nextOffset !== undefined ? <button className="btn small outline" disabled={busy} onClick={() => void more()}>{zh ? "更多条目" : "More entries"}</button> : null}</aside><article><h3>{selected?.label ?? (zh ? "选择一个条目" : "Select an entry")}</h3><pre>{body}</pre>{nextBody !== undefined && selected ? <button className="btn small outline" disabled={busy} onClick={() => void read(selected, true)}>{zh ? "加载更多正文" : "Load more content"}</button> : null}</article></div>
  </section></div>;
}
