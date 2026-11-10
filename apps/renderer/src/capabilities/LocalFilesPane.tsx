import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { LocalResourceResultMap, LocalResourceRow } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { createPreviewLocalFiles } from "../preview/resourcesPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";
import { WorkspaceDialog, WorkspaceEmpty } from "../workspaces/Workspace";
import { CapabilityEditor } from "./CapabilityEditor";
import "./resources.css";

const MAX_TEXT_BYTES = 512 * 1024;
type LocalDocument = LocalResourceResultMap["resource.local.open"];
type PendingNavigation = { kind: "open"; uri: string } | { kind: "refresh" };

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
}

export function resourceLanguage(uri: string): "python" | "markdown" | "cpp" | "text" {
  return /\.md$/i.test(uri) ? "markdown" : /\.py$/i.test(uri) ? "python" : /\.(?:c|cpp|cc|h|hpp)$/i.test(uri) ? "cpp" : "text";
}

/** Also used on its own by the conversation's /local dialog. */
export function LocalFilesPane({ client, sessionId, available, initialName }: {
  client: StudioClient; sessionId?: string | undefined; available: boolean; initialName?: string;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [files, setFiles] = useState<LocalResourceRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [document, setDocument] = useState<LocalDocument>();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<"checking" | "listing" | "opening" | "saving" | null>(null);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<PendingNavigation>();
  const epoch = useRef(0);
  const lock = useRef(false);
  const previewFiles = useRef(createPreviewLocalFiles());
  const initial = useRef(initialName);
  const handledInitial = useRef(initialName);
  initial.current = initialName;
  const dirty = !!document && draft !== document.text;
  const draftBytes = useMemo(() => new TextEncoder().encode(draft).byteLength, [draft]);
  const tooLarge = draftBytes > MAX_TEXT_BYTES;
  const visibleFiles = files.filter(file => `${file.name} ${file.uri}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  async function listFiles(): Promise<LocalResourceResultMap["resource.local.list"]> {
    if (preview) return { files: previewFiles.current.map(({ text: _text, version: _version, ...file }) => file), truncated: false };
    if (!sessionId) throw new Error(zh ? "尚未选择活动会话" : "No active session");
    const handle = await client.command("resource.local.list", { sessionId });
    return (await waitReceipt<{ result: LocalResourceResultMap["resource.local.list"] }>(client, handle.requestId)).result;
  }

  async function readDocument(uri: string): Promise<LocalDocument> {
    if (preview) {
      const file = previewFiles.current.find(item => item.uri === uri);
      if (!file) throw new Error(zh ? "找不到此文件" : "File not found");
      return { uri: file.uri, version: file.version, text: file.text };
    }
    if (!sessionId) throw new Error(zh ? "尚未选择活动会话" : "No active session");
    const handle = await client.command("resource.local.open", { sessionId, uri });
    return (await waitReceipt<{ result: LocalDocument }>(client, handle.requestId)).result;
  }

  function acceptDocument(value: LocalDocument | undefined) {
    setDocument(value); setDraft(value?.text ?? ""); setSaved(false); setSaveFailed(false);
  }

  useEffect(() => {
    const generation = ++epoch.current;
    lock.current = true;
    previewFiles.current = createPreviewLocalFiles();
    handledInitial.current = initial.current;
    setFiles([]); setTruncated(false); acceptDocument(undefined); setSearch(""); setError(""); setPending(undefined); setSupported(false);
    setBusy(preview || (available && sessionId) ? "checking" : null);
    void (async () => {
      try {
        if (!preview && (!available || !sessionId)) return;
        const canList = preview || (await client.query("capabilities.get", {})).capabilities.some(cap => cap.id === "resource.local.list" && cap.grade !== "unavailable");
        if (generation !== epoch.current) return;
        setSupported(canList);
        if (!canList) return;
        setBusy("listing");
        const result = await listFiles();
        if (generation !== epoch.current) return;
        setFiles(result.files); setTruncated(result.truncated);
        handledInitial.current = initial.current;
        const selected = initial.current
          ? result.files.find(file => file.name === initial.current || file.uri === initial.current)
          : result.files.find(file => file.bytes <= MAX_TEXT_BYTES);
        if (selected && selected.bytes <= MAX_TEXT_BYTES) {
          setBusy("opening");
          const value = await readDocument(selected.uri);
          if (generation === epoch.current) acceptDocument(value);
        }
      } catch (cause) {
        if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "无法读取本地会话文件" : "Could not load session-local files"));
      } finally {
        if (generation === epoch.current) { lock.current = false; setBusy(null); }
      }
    })();
    return () => { epoch.current++; };
  }, [client, sessionId, available, preview]);

  async function navigate(action: PendingNavigation) {
    if (lock.current || !supported) return;
    const generation = epoch.current;
    lock.current = true; setBusy(action.kind === "refresh" ? "listing" : "opening"); setError(""); setPending(undefined);
    try {
      if (action.kind === "open") {
        const result = await readDocument(action.uri);
        if (generation === epoch.current) acceptDocument(result);
      } else {
        const result = await listFiles();
        if (generation !== epoch.current) return;
        setFiles(result.files); setTruncated(result.truncated);
        const selected = result.files.find(file => file.uri === document?.uri);
        if (selected && selected.bytes <= MAX_TEXT_BYTES) {
          setBusy("opening");
          const value = await readDocument(selected.uri);
          if (generation === epoch.current) acceptDocument(value);
        } else acceptDocument(undefined);
      }
    } catch (cause) {
      if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "读取失败，请重试；当前内容已保留" : "Could not read the file. Your current content is preserved."));
    } finally {
      if (generation === epoch.current) { lock.current = false; setBusy(null); }
    }
  }

  function requestNavigation(action: PendingNavigation) {
    if (lock.current || pending) return;
    if (dirty) setPending(action);
    else void navigate(action);
  }

  // Changing the /local target is navigation, not a reason to silently reset a draft.
  useEffect(() => {
    if (!initialName || initialName === handledInitial.current || busy || pending) return;
    const selected = files.find(file => file.name === initialName || file.uri === initialName);
    if (selected && selected.bytes <= MAX_TEXT_BYTES) {
      handledInitial.current = initialName;
      if (selected.uri !== document?.uri) requestNavigation({ kind: "open", uri: selected.uri });
    }
  }, [initialName, files, busy, pending]);

  async function save() {
    if (lock.current || pending || !document || !dirty || tooLarge || !supported) return;
    const generation = epoch.current;
    const text = draft;
    lock.current = true; setBusy("saving"); setError(""); setSaved(false); setSaveFailed(false);
    try {
      let result: LocalResourceResultMap["resource.local.save"];
      if (preview) result = { uri: document.uri, version: document.version === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64), saved: true };
      else {
        if (!sessionId) throw new Error(zh ? "尚未选择活动会话" : "No active session");
        const handle = await client.command("resource.local.save", { sessionId, uri: document.uri, version: document.version, text });
        result = (await waitReceipt<{ result: LocalResourceResultMap["resource.local.save"] }>(client, handle.requestId)).result;
      }
      if (generation !== epoch.current) return;
      setDocument({ uri: result.uri, version: result.version, text }); setSaved(true);
      if (preview) {
        previewFiles.current = previewFiles.current.map(file => file.uri === result.uri ? { ...file, text, version: result.version, bytes: draftBytes, modifiedAt: Date.now() } : file);
        setFiles(previewFiles.current);
      } else {
        // The save receipt has no mtime: don't present the renderer's clock as Host truth.
        try {
          const listed = await listFiles();
          if (generation === epoch.current) { setFiles(listed.files); setTruncated(listed.truncated); }
        } catch { /* The save succeeded; existing metadata stays until the next refresh. */ }
      }
    } catch (cause) {
      if (generation === epoch.current) {
        setSaveFailed(true);
        setError(hostErrorMessage(cause, zh ? "保存失败，文件可能已被外部修改" : "Save failed; the file may have changed externally"));
      }
    } finally {
      if (generation === epoch.current) { lock.current = false; setBusy(null); }
    }
  }

  const emptyReason = !preview && !sessionId ? (zh ? "选择一个活动会话后查看它的 local:// 文件。" : "Select an active session to view its local:// files.")
    : !preview && !available ? (zh ? "连接 Runtime 后可以读取和编辑本地会话文件。" : "Connect the Runtime to read and edit session-local files.")
    : !supported ? (zh ? "当前 Runtime 没有本地文件编辑接口。" : "Local editing is not available in this Runtime.")
    : zh ? "这些文件属于当前会话，不会复制到工作区。" : "These files belong to this session and are not copied into the workspace.";
  const chosen = files.find(file => file.uri === document?.uri);

  return <section className="resources-local" aria-label={zh ? "本地会话文件" : "Session-local files"}>
    <div className="resources-local-intro"><Icon name="folder" /><p>{zh ? "原位编辑会话文件" : "Edit session files in place"}<span>{zh ? "UTF-8 文本 · 最大 512 KiB · 保存校验版本" : "UTF-8 text · up to 512 KiB · version-checked saves"}</span></p>{preview && marks ? <span className="resources-demo">{zh ? "演示" : "Demo"}</span> : null}</div>
    <div className="resources-split">
      <aside className="resources-sidebar" aria-label={zh ? "文件导航" : "File navigation"}>
        <header className="resources-sidebar-head"><h3>{zh ? "本地文件" : "Local files"}</h3><button type="button" className="icon-btn" aria-label={zh ? "刷新本地文件" : "Refresh local files"} data-tip={zh ? "刷新本地文件" : "Refresh local files"} disabled={!!busy || !supported || !!pending} onClick={() => requestNavigation({ kind: "refresh" })}><Icon name="refresh" /></button></header>
        <div className="resources-search"><Icon name="search" /><input aria-label={zh ? "搜索本地文件" : "Search local files"} placeholder={zh ? "搜索文件名…" : "Search filenames…"} value={search} onChange={event => setSearch(event.target.value)} /></div>
        <nav className="resources-file-list" aria-label={zh ? "本地文件列表" : "Local file list"}>
          {visibleFiles.map(file => <button type="button" className={`resources-file${document?.uri === file.uri ? " is-selected" : ""}`} key={file.uri} aria-current={document?.uri === file.uri ? "true" : undefined} disabled={!!busy || !!pending || file.bytes > MAX_TEXT_BYTES} data-tip={file.bytes > MAX_TEXT_BYTES ? (zh ? "超出 512 KiB 文本编辑上限" : "Exceeds the 512 KiB editing limit") : file.uri} onClick={() => { if (document?.uri !== file.uri) requestNavigation({ kind: "open", uri: file.uri }); }}>
            <Icon name="file-code" /><span className="resources-file-info"><strong>{file.name}</strong><span>{fileSize(file.bytes)}<span aria-hidden="true"> · </span><time dateTime={new Date(file.modifiedAt).toISOString()}>{new Date(file.modifiedAt).toLocaleDateString(zh ? "zh-CN" : "en-US", { month: "short", day: "numeric" })}</time></span></span>{document?.uri === file.uri && dirty ? <span className="resources-dirty-dot" aria-label={zh ? "未保存" : "Unsaved"} /> : null}
          </button>)}
          {!visibleFiles.length ? <p className="resources-list-empty" role="status">{busy ? (zh ? "正在读取文件…" : "Loading files…") : search ? (zh ? "没有匹配的文件" : "No matching files") : supported ? (zh ? "没有 local:// 文件" : "No local:// files") : emptyReason}</p> : null}
        </nav>
        <footer className="resources-sidebar-foot"><code>local://</code><span>{truncated ? (zh ? "仅显示部分文件" : "Partial listing") : (zh ? "当前会话" : "Current session")}</span></footer>
      </aside>
      <div className="resources-document" aria-busy={!!busy}>
        {document ? <>
          <header className="resources-document-head"><div className="resources-document-title"><Icon name="file-code" /><h3>{chosen?.name ?? document.uri.slice("local://".length)}</h3><span className={`resources-state${dirty ? " is-dirty" : ""}`} role="status">{busy === "saving" ? (zh ? "保存中…" : "Saving…") : dirty ? (zh ? "未保存" : "Unsaved") : saved ? (zh ? "已保存到原文件" : "Saved in place") : (zh ? "已打开" : "Opened")}</span></div><code className="resources-uri">{document.uri}</code></header>
          {error ? <div className="resources-notice is-error" role="alert"><Icon name="alert-c" /><div><strong>{saveFailed ? (zh ? "保存未完成，草稿已保留" : "Not saved. Your draft is preserved.") : (zh ? "读取未完成" : "Read failed")}</strong><p>{error}</p>{saveFailed ? <p>{zh ? "若文件已被外部修改，请先复制需要保留的草稿，再重新打开最新文件；不会覆盖外部版本。" : "If the file changed externally, copy any draft you need before reopening the latest file. The external version has not been overwritten."}</p> : null}</div></div> : null}
          <CapabilityEditor key={document.uri} value={draft} label={zh ? "本地文件正文" : "Local file content"} language={resourceLanguage(document.uri)} readOnly={!!busy || !!pending || !supported} onChange={value => { if (!lock.current && !pending) { setDraft(value); setSaved(false); } }} onSubmit={() => void save()} className="resources-text-editor" />
          {tooLarge ? <p className="resources-limit" role="alert">{zh ? "草稿超过 512 KiB，请缩短后保存。" : "This draft exceeds 512 KiB. Shorten it before saving."}</p> : null}
          <div className="resources-editor-actions"><button type="button" className="btn primary" disabled={!!busy || !!pending || !dirty || tooLarge || !supported} onClick={() => void save()}><Icon name="check" />{zh ? "保存到原文件" : "Save in place"}</button><button type="button" className="btn ghost" disabled={!!busy || !!pending || !dirty} onClick={() => { setDraft(document.text); setSaved(false); }}>{zh ? "撤销草稿" : "Revert draft"}</button><button type="button" className="btn ghost" disabled={!!busy || !!pending || !supported} onClick={() => requestNavigation({ kind: "open", uri: document.uri })}><Icon name="refresh" />{zh ? "重新打开" : "Reopen"}</button></div>
          <footer className="resources-document-foot"><span>UTF-8 <span aria-hidden="true">·</span> {fileSize(draftBytes)}</span><span>{zh ? "版本" : "Version"} <code data-tip={document.version}>{document.version.slice(0, 8)}</code></span>{chosen ? <time dateTime={new Date(chosen.modifiedAt).toISOString()}>{zh ? "修改于 " : "Modified "}{new Date(chosen.modifiedAt).toLocaleString(zh ? "zh-CN" : "en-US")}</time> : null}</footer>
        </> : <>
          <WorkspaceEmpty icon="file-code" title={busy ? (zh ? "正在读取会话文件" : "Loading session files") : (zh ? "选择文件，开始编辑" : "Choose a file to edit")}>{emptyReason}</WorkspaceEmpty>
          {error ? <div className="resources-notice is-error" role="alert"><Icon name="alert-c" /><p>{error}</p></div> : null}
        </>}
      </div>
    </div>
    {pending ? <WorkspaceDialog title={zh ? "放弃未保存的修改？" : "Discard unsaved changes?"} onClose={() => setPending(undefined)}><p className="resources-confirm-copy">{zh ? "当前文件有未保存的草稿。继续后将读取文件内容，草稿会被替换；原文件不会被修改。" : "This file has an unsaved draft. Continuing replaces it with file contents without modifying the original file."}</p><code className="resources-confirm-uri">{document?.uri}</code><div className="resources-confirm-actions"><button type="button" className="btn ghost" onClick={() => setPending(undefined)}>{zh ? "继续编辑" : "Keep editing"}</button><button type="button" className="btn primary" onClick={() => void navigate(pending)}>{zh ? "放弃草稿并继续" : "Discard and continue"}</button></div></WorkspaceDialog> : null}
  </section>;
}
