import { useEffect, useState } from "react";
import type { BrowserCapability, BrowserPageInspection, ManagedBrowserDownload, ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { useSurfaceChrome } from "../dock/SurfaceContext";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewBrowserInspection } from "../preview/browserPreview";
import { useBrowserVisible } from "./useNativeBrowserObservation";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { Switch } from "../settings/SettingRow";
import type { BrowserSession, BrowserSessionSnapshot } from "./browserSessions";
import type { Copy } from "./BrowserToolbar";

export type BrowserView = "downloads" | "settings" | "console" | "network" | "capabilities";

const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const PERMISSIONS: Record<string, [string, string]> = {
  notifications: ["通知", "Notifications"], "media:audio": ["麦克风", "Microphone"], "media:video": ["摄像头", "Camera"],
  "clipboard-read": ["读取剪贴板", "Read clipboard"], "clipboard-readwrite": ["读取剪贴板", "Read clipboard"], geolocation: ["位置信息", "Location"], fullscreen: ["全屏", "Full screen"],
};

/** Secondary views release capture/control. Their data stays window-local and is read only while visible. */
export function BrowserViews({ view, session, snap, page, inspection, inspectionBusy = false, inspectionError = "", onRefresh, visible = true, copy, onBack }: {
  view: BrowserView; session: BrowserSession; snap: BrowserSessionSnapshot; page?: ManagedBrowserPage | undefined; inspection?: BrowserPageInspection | undefined;
  inspectionBusy?: boolean; inspectionError?: string; onRefresh?: (() => void) | undefined; visible?: boolean; copy: Copy; onBack: () => void;
}) {
  const api = useSurfaceChrome()?.managedBrowser, { preview } = usePreviewMode(), shown = useBrowserVisible(visible);
  const [embedded, setEmbedded] = useState<BrowserPageInspection>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [revision, refresh] = useState(0);
  const native = !!page?.descriptor && page.descriptor.transport !== "embedded";
  const inspect = view === "console" || view === "network" || native && view === "downloads";
  useEffect(() => {
    setEmbedded(undefined); setError(""); setBusy(false);
    if (!shown || native || !page || (view !== "console" && view !== "network")) return;
    if (preview) { setEmbedded(previewBrowserInspection(view)); return; }
    if (!api?.inspect) { setError(copy("当前 Desktop 没有接入此页面的私有检查通道。", "This Desktop has no private inspection channel for this page.")); return; }
    let current = true;
    const request = { sessionId: session.id, pageId: page.id, ...(page.descriptor ? { generation: page.descriptor.generation } : {}), view, visible: true };
    setBusy(true);
    void api.inspect(request).then(value => { if (current) setEmbedded(value); }, cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; void api.inspect?.({ ...request, visible: false }).catch(() => undefined); };
  }, [api, page?.id, page?.descriptor?.generation, native, view, session, shown, preview, revision, copy]);
  const title = view === "downloads" ? copy("下载", "Downloads") : view === "settings" ? copy("Embedded 浏览器设置", "Embedded browser settings") : view === "capabilities" ? copy("页面与能力", "Page and capabilities") : view === "console" ? "Console" : "Network";
  return <div className="mb-view">
    <header className="mb-view-header">
      <button type="button" className="icon-btn" aria-label={copy("返回网页", "Back to the page")} data-tip={copy("返回网页", "Back to the page")} onClick={onBack}><Icon name="arrow-l" extra="sm" /></button>
      <h2>{title}</h2>
      {inspect ? <button type="button" className="btn small ghost" disabled={!shown || busy || inspectionBusy} onClick={() => { if (native) onRefresh?.(); else refresh(value => value + 1); }}>{copy("刷新", "Refresh")}</button> : null}
    </header>
    <div className="mb-view-body">{view === "capabilities" ? <PageCapabilities page={page} copy={copy} />
      : inspect ? <Inspection inspection={native ? inspection : embedded} busy={busy || inspectionBusy} error={inspectionError || error} reason={page?.descriptor?.capabilities.reasons[view as "console" | "network" | "downloads"]} copy={copy} />
      : view === "downloads" ? <Downloads session={session} snap={snap} pageId={page?.id} copy={copy} />
      : native || page?.descriptor?.capabilities.settings === false ? <p className="mb-view-empty">{page?.descriptor?.capabilities.reasons.settings ?? copy("原生浏览器沿用 CLI 配置；此设置区只属于明确的 embedded adapter。", "Native browsers inherit CLI configuration. These settings belong only to the explicit embedded adapter.")}</p>
      : <Settings session={session} snap={snap} copy={copy} />}</div>
  </div>;
}

const CAPABILITIES: [BrowserCapability, string, string][] = [
  ["observe", "同页呈现", "Same-page display"], ["control", "同页接管", "Same-page control"], ["nativeViewer", "同 view 原生窗口", "Same-view native window"], ["history", "前进 / 后退", "Navigation history"],
  ["console", "Console", "Console"], ["network", "Network", "Network"], ["downloads", "下载", "Downloads"], ["webmcp", "WebMCP", "WebMCP"], ["pdf", "PDF", "PDF"], ["cdp", "完整 CDP", "Full CDP"], ["tracing", "Tracing", "Tracing"],
  ["zoom", "缩放", "Zoom"], ["find", "页面内查找", "Find in page"], ["pick", "元素选择", "Element picking"], ["devtools", "DevTools", "DevTools"], ["settings", "Embedded 设置", "Embedded settings"],
];
function PageCapabilities({ page, copy }: { page?: ManagedBrowserPage | undefined; copy: Copy }) {
  const descriptor = page?.descriptor;
  if (!descriptor) return <p className="mb-view-empty">{copy("旧 Runtime 没有提供原生页面描述；不能从 Electron API 推断其他后端的引擎或能力。", "This legacy Runtime provides no native page descriptor. Electron API presence does not establish another backend's engine or capabilities.")}</p>;
  return <><dl className="mb-page-identity">
    <dt>{copy("实际引擎", "Actual engine")}</dt><dd>{descriptor.engine}</dd><dt>{copy("呈现通道", "Display transport")}</dt><dd>{descriptor.transport}</dd>
    <dt>Target</dt><dd>{descriptor.targetId}</dd><dt>{copy("原生 Owner", "Native owner")}</dt><dd>{descriptor.ownerSessionId}</dd>
    <dt>Session</dt><dd>{descriptor.sessionId}</dd><dt>Generation</dt><dd>{descriptor.generation}</dd><dt>{copy("页面生命周期", "Page ownership")}</dt><dd>{descriptor.ownership}</dd>
  </dl><p className="mb-view-empty">{copy("观察、隐藏和归还不关闭 CLI 页面；真正关闭会遵循 owned / borrowed 生命周期。更换引擎只作用于新开页面。", "Viewing, hiding and returning control leave the CLI page open. Real close follows owned / borrowed lifetimes. Engine choices apply only to new pages.")}</p>
    <ul className="mb-list mb-capabilities">{CAPABILITIES.map(([key, zh, en]) => <li key={key}><Icon name={descriptor.capabilities[key] ? "check" : "x"} extra="sm" /><span>{copy(zh, en)}</span><strong>{descriptor.capabilities[key] ? copy("可用", "Available") : copy("不可用", "Unavailable")}</strong>{descriptor.capabilities.reasons[key] ? <p>{descriptor.capabilities.reasons[key]}</p> : null}</li>)}</ul></>;
}
function Inspection({ inspection, busy, error, reason, copy }: { inspection?: BrowserPageInspection | undefined; busy: boolean; error: string; reason?: string | undefined; copy: Copy }) {
  return <>{error ? <p role="alert" className="mb-view-empty">{error}</p> : null}{reason || inspection?.reason ? <p className="mb-view-empty" role="status">{inspection?.reason ?? reason}</p> : null}
    {busy ? <p className="mb-view-empty" role="status">{copy("正在读取原生页面…", "Reading the native page…")}</p> : null}
    {inspection && !inspection.rows.length ? <p className="mb-view-empty">{copy("此页面当前没有相关记录。", "This page has no matching records yet.")}</p> : null}
    {inspection?.view === "console" ? <ul className="mb-list mb-inspection">{inspection.rows.map((row, index) => <li key={index}><span className="chip gray xs">{row.level}</span><pre>{row.text}</pre>{row.location ? <code>{row.location}</code> : null}</li>)}</ul>
      : inspection?.view === "network" ? <ul className="mb-list mb-inspection">{inspection.rows.map(row => <li key={row.id}><span className="chip gray xs">{row.method} · {row.status ?? "—"}</span><code>{row.url}</code>{row.failure ? <p role="status">{row.failure}</p> : null}</li>)}</ul>
      : inspection?.view === "downloads" ? <ul className="mb-list mb-inspection">{inspection.rows.map((row, index) => <li key={index}><strong>{row.name}</strong><span>{row.state}{row.bytes === undefined ? "" : ` · ${size(row.bytes)}`}</span><code>{row.path ?? row.url}</code></li>)}</ul> : null}</>;
}

function DownloadRow({ download, session, busy, copy }: { download: ManagedBrowserDownload; session: BrowserSession; busy: boolean; copy: Copy }) {
  const progress = download.totalBytes > 0 ? Math.min(1, download.receivedBytes / download.totalBytes) : 0;
  const status = download.state === "completed" ? size(download.totalBytes || download.receivedBytes)
    : download.state === "progressing" ? `${size(download.receivedBytes)} / ${download.totalBytes ? size(download.totalBytes) : "?"}`
    : download.state === "cancelled" ? copy("已取消", "Cancelled") : copy("下载中断", "Interrupted");
  return <li className="mb-download" data-state={download.state}>
    <span className="mb-download-mark" aria-hidden="true"><Icon name={download.state === "completed" ? "check" : download.state === "progressing" ? "download" : "x"} extra="sm" /></span>
    <div className="mb-download-body">
      <strong title={download.path || download.name}>{download.name}</strong>
      {download.state === "progressing" ? <span className="mb-download-progress" role="progressbar" aria-label={download.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${progress * 100}%` }} /></span> : null}
      <span className="mb-download-status">{status}</span>
    </div>
    <div className="mb-row-actions">
      {download.state === "completed" ? <>
        <button type="button" className="btn small outline" disabled={busy} onClick={() => void session.execute({ action: "download-open", downloadId: download.id })}>{copy("打开", "Open")}</button>
        <button type="button" className="icon-btn" disabled={busy} aria-label={copy("在文件夹中显示", "Show in folder")} data-tip={copy("在文件夹中显示", "Show in folder")} onClick={() => void session.execute({ action: "download-reveal", downloadId: download.id })}><Icon name="folder-open" extra="sm" /></button>
      </> : download.state === "progressing" ? <button type="button" className="btn small outline" disabled={busy} onClick={() => void session.execute({ action: "download-cancel", downloadId: download.id })}>{copy("取消", "Cancel")}</button> : null}
    </div>
  </li>;
}

function Downloads({ session, snap, pageId, copy }: { session: BrowserSession; snap: BrowserSessionSnapshot; pageId?: string | undefined; copy: Copy }) {
  const downloads = (snap.state?.downloads ?? []).filter(download => !pageId || download.pageId === pageId);
  if (!downloads.length) return <p className="mb-view-empty">{copy("还没有下载。网页中下载的文件会出现在这里，完成时也会通知你。", "No downloads yet. Files downloaded from pages show up here, with a notice when they finish.")}</p>;
  return <ul className="mb-list">{[...downloads].reverse().map(download => <DownloadRow key={download.id} download={download} session={session} busy={snap.busy.includes("")} copy={copy} />)}</ul>;
}

function Settings({ session, snap, copy }: { session: BrowserSession; snap: BrowserSessionSnapshot; copy: Copy }) {
  const state = snap.state!;
  const [name, setName] = useState("");
  const [limit, setLimit] = useState(String(state.settings.maxTabs));
  const [directory, setDirectory] = useState(state.settings.downloadDirectory);
  const [ask, setAsk] = useState(state.settings.askDownloadLocation);
  useEffect(() => { setLimit(String(state.settings.maxTabs)); setDirectory(state.settings.downloadDirectory); setAsk(state.settings.askDownloadLocation); }, [state.settings.maxTabs, state.settings.downloadDirectory, state.settings.askDownloadLocation]);
  const busy = snap.busy.includes("");
  const dirty = limit !== String(state.settings.maxTabs) || directory !== state.settings.downloadDirectory || ask !== state.settings.askDownloadLocation;
  const spaceName = (id: string) => state.spaces.find(space => space.id === id)?.name ?? id;
  return <div className="mb-settings">
    <section className="mb-section">
      <h3>{copy("浏览空间", "Browser spaces")}</h3>
      <p>{copy("每个空间有独立的 Cookie 和站点存储，适合隔离测试账号。新标签使用下面选中的空间，已打开的网页不受影响。", "Each space keeps its own cookies and site storage, which helps isolate test accounts. New tabs use the space chosen below; open pages keep theirs.")}</p>
      <label className="mb-field"><span>{copy("新标签使用", "New tabs use")}</span>
        <AppSelect aria-label={copy("新标签使用的浏览空间", "Browser space for new tabs")} value={snap.newTabSpaceId} onChange={event => session.setNewTabSpace(event.target.value)}>
          {state.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </AppSelect>
      </label>
      <form className="mb-inline" onSubmit={event => { event.preventDefault(); void session.execute({ action: "space-create", name }).then(result => { if (result) { setName(""); const created = result.spaces.at(-1); if (created) session.setNewTabSpace(created.id); } }); }}>
        <input className="input" aria-label={copy("新空间名称", "New space name")} placeholder={copy("新空间名称，例如：测试账号", "New space name, such as Test account")} value={name} onChange={event => setName(event.target.value)} />
        <button type="submit" className="btn small outline" disabled={busy || !name.trim()}><Icon name="plus" extra="sm" />{copy("新建空间", "New space")}</button>
      </form>
    </section>
    <form className="mb-section" onSubmit={event => { event.preventDefault(); void session.execute({ action: "settings", settings: { maxTabs: Number(limit), downloadDirectory: directory, askDownloadLocation: ask } }); }}>
      <h3>{copy("标签与下载", "Tabs and downloads")}</h3>
      <label className="mb-field"><span>{copy("每个对话最多打开的网页", "Pages per chat")}</span><input className="input mb-field-number" type="number" min={1} step={1} required value={limit} onChange={event => setLimit(event.target.value)} /></label>
      <label className="mb-field"><span>{copy("下载保存到", "Save downloads to")}</span><input className="input" value={directory} spellCheck={false} onChange={event => setDirectory(event.target.value)} /></label>
      <div className="mb-field mb-field-switch"><span>{copy("每次下载前询问保存位置", "Ask where to save each download")}</span><Switch checked={ask} label={copy("每次下载前询问保存位置", "Ask where to save each download")} onChange={setAsk} /></div>
      <div className="mb-section-actions"><button type="submit" className="btn small primary" disabled={busy || !dirty}>{copy("保存设置", "Save settings")}</button></div>
    </form>
    <section className="mb-section">
      <h3>{copy("网站权限", "Site permissions")}</h3>
      {!state.permissions.length ? <p className="mb-view-empty">{copy("还没有记住的权限。网站申请权限时勾选“记住”，选择会出现在这里。", "No remembered permissions. When a site asks and you choose to remember, it shows up here.")}</p>
        : <ul className="mb-list">{state.permissions.map(permission => <li className="mb-permission" key={`${permission.spaceId}:${permission.origin}:${permission.permission}`}>
          <div className="mb-permission-body"><strong>{permission.origin}</strong>
            <span className="mb-permission-tags"><span className={`chip xs ${permission.allowed ? "green" : "red"}`}>{permission.allowed ? copy("允许", "Allowed") : copy("拒绝", "Denied")}</span>
              <span className="chip xs gray">{copy(...(PERMISSIONS[permission.permission] ?? [permission.permission, permission.permission] as [string, string]))}</span>
              <span className="mb-permission-space">{spaceName(permission.spaceId)}</span></span>
          </div>
          <button type="button" className="btn small outline" disabled={busy} onClick={() => void session.execute({ action: "permission-forget", ...permission })}>{copy("撤销", "Forget")}</button>
        </li>)}</ul>}
    </section>
  </div>;
}
