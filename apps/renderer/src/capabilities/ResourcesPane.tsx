import { useEffect, useId, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ResourcePage } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_RESOURCE, PREVIEW_RESOURCE_EXAMPLES, readPreviewResource } from "../preview/resourcesPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon, type IconName } from "../icons";
import { WorkspaceEmpty, WorkspacePanel, WorkspaceTabs } from "../workspaces/Workspace";
import { CapabilityEditor } from "./CapabilityEditor";
import { LocalFilesPane, resourceLanguage } from "./LocalFilesPane";
import "./resources.css";

type ResourceProps = { client: StudioClient; sessionId: string | undefined; available: boolean };
type Scheme = keyof typeof PREVIEW_RESOURCE_EXAMPLES;
const PROTOCOLS: { scheme: Scheme; icon: IconName; title: [string, string]; description: [string, string] }[] = [
  { scheme: "local", icon: "folder", title: ["会话文件", "Session files"], description: ["读取当前会话的 local:// 文件。需要修改时，请使用「本地文件」页签。", "Read files owned by the current session. To edit an existing text file, use Local files."] },
  { scheme: "omp", icon: "book", title: ["内置文档", "Built-in documentation"], description: ["omp:// 或 omp://docs 读取 Runtime 内置文档索引，不是会话文件目录。", "omp:// or omp://docs reads the Runtime's built-in documentation index, not a session file directory."] },
  { scheme: "attachment", icon: "attach", title: ["会话附件", "Session attachments"], description: ["通过已有的 attachment:// URI 读取当前会话中的图片。这里不枚举附件，请使用对话中已有的地址。", "Read a session image using an existing attachment:// URI. Attachments are not listed here; use an address from the conversation."] },
  { scheme: "conflict", icon: "diff", title: ["已注册冲突", "Registered conflicts"], description: ["读取已注册的 conflict:// 冲突块。地址可带 /ours、/theirs 或 /base；这里不扫描或列举文件冲突。", "Read a registered conflict:// block, optionally with /ours, /theirs or /base. This reader does not scan or list file conflicts."] },
];

export function ResourcesPane({ client, sessionId, available }: ResourceProps) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const tabsId = useId();
  const [tab, setTab] = useState<"local" | "uri">("local");
  return <section className="resources-workspace" aria-label={zh ? "资源工作区" : "Resources workspace"}>
    <header className="resources-heading"><div><div className="resources-heading-title"><Icon name="folder-open" /><h2>{zh ? "资源" : "Resources"}</h2>{preview && marks ? <span className="resources-demo">{zh ? "演示" : "Demo"}</span> : null}</div><p>{zh ? "整理会话文件，按地址查看文档、附件与冲突。" : "Work with session files and read documentation, attachments and conflicts by URI."}</p></div>{!preview && sessionId ? <div className="resources-session"><Icon name="message" /><span>{zh ? "会话" : "Session"}</span><code data-tip={sessionId}>{sessionId}</code></div> : null}</header>
    <WorkspaceTabs<"local" | "uri"> id={tabsId} label={zh ? "资源视图" : "Resource views"} value={tab} onChange={setTab} items={[{ id: "local", label: zh ? "本地文件" : "Local files", icon: "file-code" }, { id: "uri", label: zh ? "按 URI 读取" : "Read by URI", icon: "book" }]} />
    <WorkspacePanel id={tabsId} name="local" active={tab === "local"}><LocalFilesPane client={client} sessionId={sessionId} available={available} /></WorkspacePanel>
    <WorkspacePanel id={tabsId} name="uri" active={tab === "uri"}><ResourceReader client={client} sessionId={sessionId} available={available} /></WorkspacePanel>
  </section>;
}

function ResourceReader({ client, sessionId, available }: ResourceProps) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const addressId = useId();
  const [uri, setUri] = useState(preview ? PREVIEW_RESOURCE.uri : "local://");
  const [page, setPage] = useState<ResourcePage>();
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const lock = useRef(false);
  const protocol = PROTOCOLS.find(item => uri.trim().startsWith(`${item.scheme}://`));
  const hasTarget = !!protocol && (protocol.scheme === "omp" || uri.trim().length > protocol.scheme.length + 3);

  useEffect(() => {
    const generation = ++epoch.current;
    lock.current = false;
    setUri(preview ? PREVIEW_RESOURCE.uri : "local://"); setPage(undefined); setPreviousOffsets([]); setRecent([]); setError(""); setBusy(false); setSupported(preview);
    setChecking(!preview && available && !!sessionId);
    if (!preview && available && sessionId) void client.query("capabilities.get", {}).then(value => {
      if (generation === epoch.current) setSupported(value.capabilities.some(cap => cap.id === "resource.read" && cap.grade !== "unavailable"));
    }).catch(cause => {
      if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "无法检查资源读取能力" : "Could not check resource support"));
    }).finally(() => { if (generation === epoch.current) setChecking(false); });
    return () => { epoch.current++; };
  }, [client, sessionId, available, preview]);

  async function read(targetUri: string, cursor?: { offset: number; version: string; previous: number[] }) {
    if (lock.current || !supported || !targetUri.trim()) return;
    const generation = epoch.current;
    lock.current = true; setBusy(true); setError("");
    try {
      let result: ResourcePage;
      if (preview) result = readPreviewResource(targetUri.trim(), cursor?.offset, cursor?.version);
      else {
        if (!available || !sessionId) throw new Error(zh ? "请先连接活动会话" : "Connect an active session first");
        const handle = await client.command("resource.read", { sessionId, uri: targetUri.trim(), ...(cursor ? { offset: cursor.offset, version: cursor.version } : {}) });
        result = (await waitReceipt<{ result: ResourcePage }>(client, handle.requestId)).result;
      }
      if (generation !== epoch.current) return;
      setPage(result); setPreviousOffsets(cursor?.previous ?? []);
      setRecent(current => [result.uri, ...current.filter(item => item !== result.uri)].slice(0, 12));
    } catch (cause) {
      if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "资源读取失败，请检查地址或重新读取" : "Could not read the resource. Check the URI or read it again."));
    } finally {
      // An earlier session must never unlock a request owned by the new session.
      if (generation === epoch.current) { lock.current = false; setBusy(false); }
    }
  }

  const unavailable = !preview && !sessionId ? (zh ? "选择活动会话后即可读取资源。" : "Choose an active session to read resources.")
    : !preview && !available ? (zh ? "Runtime 未连接，请连接后重试。" : "The Runtime is disconnected. Connect it and try again.")
    : zh ? "当前 Runtime 未提供资源查看能力。" : "Resource viewing is not available in this Runtime.";

  return <div className="resources-reader">
    <div className="resources-protocols" aria-label={zh ? "协议快捷入口" : "Protocol shortcuts"}>{PROTOCOLS.map(item => <button type="button" className="resources-protocol" key={item.scheme} aria-pressed={protocol?.scheme === item.scheme} onClick={() => setUri(preview ? PREVIEW_RESOURCE_EXAMPLES[item.scheme] : `${item.scheme}://`)}><Icon name={item.icon} />{item.scheme}://</button>)}</div>
    <div className="resources-split">
      <aside className="resources-sidebar resources-recent"><header className="resources-sidebar-head"><h3>{zh ? "本会话最近访问" : "Recently read in this session"}</h3><Icon name="history" /></header><nav className="resources-file-list" aria-label={zh ? "最近访问的资源" : "Recently read resources"}>{recent.map(value => <button type="button" className={`resources-file${page?.uri === value ? " is-selected" : ""}`} key={value} disabled={busy || !supported} aria-current={page?.uri === value ? "true" : undefined} data-tip={value} onClick={() => { setUri(value); void read(value); }}><Icon name={PROTOCOLS.find(item => value.startsWith(`${item.scheme}://`))?.icon ?? "file"} /><span className="resources-file-info"><strong>{value}</strong><span>{zh ? "已成功读取" : "Read successfully"}</span></span></button>)}{!recent.length ? <p className="resources-list-empty">{zh ? "成功读取的资源会出现在这里。仅保留本次打开面板期间的访问记录。" : "Successfully read resources appear here, for as long as this panel stays open."}</p> : null}</nav><div className="resources-protocol-help"><strong>{protocol?.title[zh ? 0 : 1] ?? (zh ? "支持四种资源协议" : "Four resource protocols")}</strong><p>{protocol?.description[zh ? 0 : 1] ?? (zh ? "使用 local://、omp://、attachment:// 或 conflict:// 开头的地址。" : "Use a local://, omp://, attachment:// or conflict:// address.")}</p>{preview && marks ? <p>{zh ? "演示数据仅在当前界面内读取，不访问 Host。" : "Demo resources stay in this interface and never reach the Host."}</p> : null}</div></aside>
      <div className="resources-document" aria-busy={busy || checking}>
        <form className="resources-address" onSubmit={event => { event.preventDefault(); if (hasTarget) void read(uri); }}><label htmlFor={addressId}>{zh ? "资源 URI" : "Resource URI"}</label><div className="resources-address-row"><input id={addressId} className="input" aria-label="Resource URI" value={uri} spellCheck={false} onChange={event => setUri(event.target.value)} placeholder="local://notes.md" /><button className="btn primary" aria-label={zh ? "读取" : "Read"} disabled={busy || checking || !supported || !hasTarget}><Icon name="eye" />{busy ? (zh ? "读取中…" : "Reading…") : (zh ? "读取" : "Read")}</button></div><p>{zh ? "只读查看 · 分页始终绑定已读取的地址和版本" : "Read-only · pages stay bound to the loaded URI and version"}</p></form>
        {error ? <div className="resources-notice is-error" role="alert"><Icon name="alert-c" /><div><strong>{zh ? "未能读取资源" : "Resource could not be read"}</strong><p>{error}</p>{page ? <p>{zh ? "已读取内容仍保留。如版本已变更，请重新读取。" : "The previously loaded content is preserved. Read it again if its version has changed."}</p> : null}</div></div> : null}
        {page ? <div className="resources-reader-content">
          <header className="resources-document-head"><div><div className="resources-document-title"><Icon name={page.image ? "image" : "file-code"} /><h3>{zh ? "资源内容" : "Resource content"}</h3><span className="resources-state">{zh ? "只读" : "Read-only"}</span></div><code className="resources-uri">{page.uri}</code></div><button type="button" className="btn ghost" disabled={busy || !supported} onClick={() => void read(page.uri)}><Icon name="refresh" />{zh ? "重新读取" : "Read again"}</button></header>
          {page.image ? <figure className="resources-image"><img alt={page.uri} src={`data:${page.image.mimeType};base64,${page.image.data}`} /></figure> : null}
          {page.text || !page.image ? <CapabilityEditor value={page.text} label={zh ? "资源正文" : "Resource content"} language={resourceLanguage(page.uri)} readOnly className="resources-text-editor" /> : null}
          <div className="resources-pagination"><span>{zh ? `第 ${previousOffsets.length + 1} 页` : `Page ${previousOffsets.length + 1}`} · {page.total ? page.offset + 1 : 0}-{page.nextOffset ?? page.total} / {page.total}{page.truncated && page.nextOffset === undefined ? (zh ? " · 内容已截断" : " · Truncated") : ""}</span><button type="button" className="btn ghost" disabled={busy || !supported || !previousOffsets.length} onClick={() => { const offset = previousOffsets.at(-1); if (offset !== undefined) void read(page.uri, { offset, version: page.version, previous: previousOffsets.slice(0, -1) }); }}><Icon name="chevron-l" />{zh ? "上一页" : "Previous page"}</button><button type="button" className="btn ghost" disabled={busy || !supported || page.nextOffset === undefined} onClick={() => { if (page.nextOffset !== undefined) void read(page.uri, { offset: page.nextOffset, version: page.version, previous: [...previousOffsets, page.offset] }); }}>{zh ? "下一页" : "Next page"}<Icon name="chevron-r" /></button></div>
          <footer className="resources-document-foot"><span>{page.image?.mimeType ?? "UTF-8"}</span><span>{zh ? "版本" : "Version"} <code data-tip={page.version}>{page.version.slice(0, 8)}</code></span></footer>
        </div> : <WorkspaceEmpty icon="book" title={checking ? (zh ? "正在检查读取能力" : "Checking resource support") : !supported ? (zh ? "资源读取暂不可用" : "Resource reader unavailable") : (zh ? "从一个资源地址开始" : "Start with a resource URI")}>{checking ? (zh ? "正在连接当前会话。" : "Connecting to the current session.") : !supported ? unavailable : (zh ? "选择协议，输入已有 URI，然后读取内容。附件和冲突按已知地址访问，不会自动列举。" : "Choose a protocol, enter an existing URI, and read its contents. Attachments and conflicts are accessed by known addresses, not listed automatically.")}</WorkspaceEmpty>}
      </div>
    </div>
  </div>;
}
