import { useEffect, useState } from "react";
import type { ManagedBrowserDownload } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { Switch } from "../settings/SettingRow";
import type { BrowserSession, BrowserSessionSnapshot } from "./browserSessions";
import type { Copy } from "./BrowserToolbar";

export type BrowserView = "downloads" | "settings";

const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const PERMISSIONS: Record<string, [string, string]> = {
  notifications: ["通知", "Notifications"], "media:audio": ["麦克风", "Microphone"], "media:video": ["摄像头", "Camera"],
  "clipboard-read": ["读取剪贴板", "Read clipboard"], "clipboard-readwrite": ["读取剪贴板", "Read clipboard"], geolocation: ["位置信息", "Location"], fullscreen: ["全屏", "Full screen"],
};

/** Downloads and settings take the page's place; the page itself stays loaded behind them. */
export function BrowserViews({ view, session, snap, copy, onBack }: { view: BrowserView; session: BrowserSession; snap: BrowserSessionSnapshot; copy: Copy; onBack: () => void }) {
  return <div className="mb-view">
    <header className="mb-view-header">
      <button type="button" className="icon-btn" aria-label={copy("返回网页", "Back to the page")} data-tip={copy("返回网页", "Back to the page")} onClick={onBack}><Icon name="arrow-l" extra="sm" /></button>
      <h2>{view === "downloads" ? copy("下载", "Downloads") : copy("浏览器设置", "Browser settings")}</h2>
    </header>
    <div className="mb-view-body">{view === "downloads" ? <Downloads session={session} snap={snap} copy={copy} /> : <Settings session={session} snap={snap} copy={copy} />}</div>
  </div>;
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

function Downloads({ session, snap, copy }: { session: BrowserSession; snap: BrowserSessionSnapshot; copy: Copy }) {
  const downloads = snap.state?.downloads ?? [];
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
