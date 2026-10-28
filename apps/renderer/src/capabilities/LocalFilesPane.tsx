import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { LocalResourceResultMap, LocalResourceRow } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { AppSelect } from "../AppSelect";

const DEMO_FILE: LocalResourceRow = { name: "PLAN.md", uri: "local://PLAN.md", bytes: 240, modifiedAt: Date.parse("2026-10-28T10:00:00Z") };
export function LocalFilesPane({ client, sessionId, available, initialName }: { client: StudioClient; sessionId?: string | undefined; available: boolean; initialName?: string }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [files, setFiles] = useState<LocalResourceRow[]>([]); const [uri, setUri] = useState(""); const [version, setVersion] = useState(""); const [text, setText] = useState(""); const [original, setOriginal] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [supported, setSupported] = useState(preview); const epoch = useRef(0);
  const invoke = async <K extends keyof LocalResourceResultMap>(kind: K, fields: Record<string, unknown> = {}): Promise<LocalResourceResultMap[K]> => {
    if (!sessionId) throw Error("Session unavailable"); const handle = await client.command(kind, { sessionId, ...fields } as never); return (await waitReceipt<{ result: LocalResourceResultMap[K] }>(client, handle.requestId)).result;
  };
  useEffect(() => {
    const generation = ++epoch.current; setFiles(preview ? [DEMO_FILE] : []); setUri(""); setVersion(""); setText(""); setOriginal(""); setError(""); setSupported(preview);
    if (!preview && available && sessionId) void client.query("capabilities.get", {}).then(async capabilities => {
      const supported = capabilities.capabilities.some(cap => cap.id === "resource.local.list" && cap.grade !== "unavailable"); if (generation !== epoch.current) return; setSupported(supported);
      if (supported) { const result = await invoke("resource.local.list"); if (generation === epoch.current) setFiles(result.files); }
    }).catch(cause => { if (generation === epoch.current) setError(hostErrorMessage(cause, "Local files unavailable")); });
    return () => { epoch.current++; };
  }, [client, sessionId, available, preview]);
  const open = async (next: string) => {
    if (busy || !next) return; if (text !== original && !window.confirm(zh ? "丢弃本地文件编辑草稿？" : "Discard local file edits?")) return;
    const generation = epoch.current; setBusy(true); setError("");
    try { const result = preview ? { uri: next, version: "demo", text: "# 实施计划\n\n- 保留会话身份\n- 验证队列和附件\n" } : await invoke("resource.local.open", { uri: next }); if (generation === epoch.current) { setUri(next); setVersion(result.version); setText(result.text); setOriginal(result.text); } }
    catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, "Could not open local file")); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  useEffect(() => { if (!initialName || uri || busy || !files.length) return; const selected = files.find(file => file.name === initialName || file.uri === initialName); if (selected) void open(selected.uri); }, [initialName, files]);
  const save = async () => {
    if (busy || !uri || text === original) return; const generation = epoch.current; setBusy(true); setError("");
    try { const result = preview ? { uri, version: "demo-saved", saved: true } : await invoke("resource.local.save", { uri, version, text }); if (generation === epoch.current) { setVersion(result.version); setOriginal(text); } }
    catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, "Local file changed or save failed; reopen before retrying")); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  return <section className="runtime-catalog-pane" aria-label={zh ? "本地会话文件" : "Session-local files"}><h3>{zh ? "本地会话文件" : "Session-local files"}{preview ? " · Demo" : ""}</h3><p className="muted">{zh ? "编辑原生 local:// 文件，不会复制到项目。保存校验内容版本，外部修改后须重新打开。支持 512 KiB 以内 UTF-8 文本。" : "Edit native local:// files in place. Saving verifies the version; reopen after external changes. UTF-8 text up to 512 KiB."}</p><AppSelect className="select" aria-label={zh ? "选择本地文件" : "Choose local file"} value={uri} disabled={!supported || busy} onChange={event => void open(event.target.value)}><option value="">{zh ? "选择文件" : "Choose a file"}</option>{files.map(file => <option key={file.uri} value={file.uri}>{file.name} · {file.bytes} B</option>)}</AppSelect>{!supported ? <p role="status">{zh ? "当前 Runtime 没有本地文件编辑接口" : "Local editor is not available in this Runtime"}</p> : !files.length ? <p className="muted">{zh ? "没有 local:// 文件" : "No local:// files"}</p> : null}{uri ? <><textarea className="input mono" rows={14} aria-label={zh ? "本地文件正文" : "Local file content"} value={text} disabled={busy} onChange={event => setText(event.target.value)} /><div className="media-toolbar"><button className="btn small outline" disabled={busy || text === original} onClick={() => void save()}>{zh ? "保存到原文件" : "Save in place"}</button><button className="btn small ghost" disabled={busy} onClick={() => { setText(original); }}>{zh ? "撤销草稿" : "Revert draft"}</button></div></> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
