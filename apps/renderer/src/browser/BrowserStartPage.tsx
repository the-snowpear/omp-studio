import { useEffect, useRef, useState } from "react";
import type { ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { AppSelect } from "../AppSelect";
import { useOptionalDock } from "../dock/DockContext";
import { browserPagePanelId } from "../dock/types";
import type { BrowserSession, BrowserSessionSnapshot } from "./browserSessions";
import { splitAddress, type Copy } from "./BrowserToolbar";

function SiteMark({ page }: { page: ManagedBrowserPage }) {
  const [failed, setFailed] = useState(false);
  return page.favicon && !failed ? <img className="mb-site-mark" src={page.favicon} alt="" draggable={false} onError={() => setFailed(true)} /> : <Icon name="globe" extra="sm" />;
}

/**
 * A new tab: the address field is the whole page. Used by the Browser tool when
 * a chat has no page open (or when added to a strip) and by blank pages.
 */
export function BrowserStartPage({ session, snap, copy, pageId, unbound = false, autoFocus = false }: {
  session: BrowserSession | null; snap: BrowserSessionSnapshot; copy: Copy; pageId?: string | undefined; unbound?: boolean; autoFocus?: boolean;
}) {
  const dock = useOptionalDock();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false), [app, setApp] = useState("inherit"), [customApp, setCustomApp] = useState(""), [argv, setArgv] = useState(""), [target, setTarget] = useState(""), [insecure, setInsecure] = useState(false);
  const state = snap.state;
  const human = state?.control === "human";
  const pending = snap.pendingLink;
  const selectedApp = session?.nativeAvailable ? app : "embedded";
  // A new native tab does not commandeer or recreate any existing tab. Embedded retains its explicit adapter policy.
  const needsTakeover = !!state && !human && (!!pageId || selectedApp === "embedded" && state.pages.some(page => !page.descriptor || page.descriptor.transport === "embedded"));
  const full = !!state && !pageId && selectedApp === "embedded" && state.pages.filter(page => !page.descriptor || page.descriptor.transport === "embedded").length >= state.settings.maxTabs;
  useEffect(() => { if (autoFocus) input.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useEffect(() => { if (pending) setValue(pending.url); }, [pending?.id]);
  const open = async (url: string) => {
    if (!session || !url.trim() || working) return;
    setWorking(true);
    try {
      if (needsTakeover && !await session.setControl("human")) return;
      const result = pageId ? await session.execute({ action: "navigate", pageId, url: url.trim() }) : await session.create(url.trim(), {
        linkKey: pending?.url === url.trim() ? pending.reuseKey : undefined,
        ...(selectedApp === "inherit" ? {} : { app: selectedApp === "custom" ? customApp.trim() : selectedApp }),
        ...(selectedApp === "custom" && argv.trim() ? { argv: argv.split(/\r?\n/u).filter(value => value.length > 0) } : {}),
        ...(selectedApp !== "embedded" && target.trim() ? { target: target.trim() } : {}), ...(selectedApp !== "embedded" && insecure ? { insecure: true } : {}),
      });
      if (result) { setValue(""); if (pending) session.setPendingLink(null); }
    } finally { setWorking(false); }
  };
  const others = state?.pages.filter(page => page.id !== pageId) ?? [];
  const reveal = (page: ManagedBrowserPage) => {
    const panel = browserPagePanelId(session!.id, page.id);
    dock?.store.dispatch({ type: "open", panel });
    dock?.store.dispatch({ type: "browser-page-focus", panel });
  };
  const disabled = unbound || !state || working || full || selectedApp === "custom" && !customApp.trim();
  return <div className="mb-start">
    <div className="mb-start-column">
      <div className="mb-start-mark" aria-hidden="true"><Icon name="globe" /></div>
      <h2 className="mb-start-title">{copy("新标签页", "New tab")}</h2>
      {!pageId ? <div className="mb-open-options">
        <label className="mb-field"><span>{copy("本次打开方式", "Open this page with")}</span><AppSelect aria-label={copy("本次浏览器适配器", "Browser adapter for this open")} value={selectedApp} disabled={working || unbound} onChange={event => { setApp(event.target.value); setInsecure(false); }}>
          <option value="inherit" disabled={!session?.nativeAvailable}>{copy("继承 CLI（默认）", "Inherit CLI (default)")}</option>
          <option value="webkit" disabled={!session?.nativeAvailable}>Native WebKit</option><option value="chromium" disabled={!session?.nativeAvailable}>Native Chromium</option><option value="relay" disabled={!session?.nativeAvailable}>Native Chrome relay</option>
          <option value="custom" disabled={!session?.nativeAvailable}>{copy("CDP 地址 / 可执行文件", "CDP endpoint / executable")}</option><option value="embedded" disabled={!session?.embeddedAvailable}>Studio embedded</option>
        </AppSelect></label>
        <p>{selectedApp === "embedded" ? copy("明确选择本机 WebContentsView；它有独立的浏览空间和下载管理，不替换已打开的 CLI 页面。", "Explicit local WebContentsView with its own spaces and downloads. It does not replace any open CLI page.") : copy("保留原生优先级、实际引擎和同一个标签。选择只作用于本次新开，不改变已经登录的页面。", "Preserves native priority and the actual engine/tab. This choice affects only the new open, not signed-in pages.")}</p>
        {selectedApp === "custom" ? <><label className="mb-field"><span>{copy("app（字符串）", "app (string)")}</span><input className="input" aria-label={copy("CDP 地址或浏览器可执行文件", "CDP endpoint or browser executable")} spellCheck={false} value={customApp} disabled={working} onChange={event => setCustomApp(event.target.value)} /></label>
          <label className="mb-field"><span>argv</span><textarea className="input mono" aria-label={copy("浏览器 argv，每行一个参数", "Browser argv, one argument per line")} rows={2} value={argv} disabled={working} onChange={event => setArgv(event.target.value)} /></label></> : null}
        {selectedApp !== "embedded" ? <details><summary>{copy("原生连接选项", "Native connection options")}</summary><label className="mb-field"><span>target</span><input className="input" aria-label={copy("原生 target，可选", "Native target, optional")} value={target} disabled={working} onChange={event => setTarget(event.target.value)} /></label>
          <label className="mb-open-insecure"><input type="checkbox" checked={insecure} disabled={working || selectedApp === "relay"} onChange={event => setInsecure(event.target.checked)} /><span>{copy("insecure：允许无效 HTTPS 证书（仅本次打开）", "insecure: allow invalid HTTPS certificates for this open")}</span></label></details> : null}
      </div> : null}
      {pending ? <div className="mb-start-request" role="status">
        <div className="mb-start-request-body"><span>{copy("要在这里打开的链接", "Link to open here")}</span><strong title={pending.url}>{pending.url}</strong></div>
        <div className="mb-start-request-actions">
          <button type="button" className="btn small outline" disabled={working} onClick={() => session?.setPendingLink(null)}>{copy("取消", "Cancel")}</button>
          <button type="button" className="btn small primary" disabled={disabled} onClick={() => void open(pending.url)}>{needsTakeover ? copy("接管并打开", "Take control and open") : copy("打开链接", "Open link")}</button>
        </div>
      </div> : null}
      <form className="mb-start-address" onSubmit={event => { event.preventDefault(); void open(value); }}>
        <Icon name="search" extra="sm" />
        <input ref={input} className="mb-start-input" aria-label={copy("浏览器地址", "Browser address")} inputMode="url" spellCheck={false} autoComplete="off" value={value} disabled={disabled}
          placeholder={unbound ? copy("先开始对话，再打开网页", "Start the chat to open pages") : copy("输入网址，例如 localhost:5173", "Enter an address, such as localhost:5173")} onChange={event => setValue(event.target.value)} />
        <button type="submit" className="btn small primary" disabled={disabled || !value.trim()}>{working ? <i className="mb-spinner" aria-hidden="true" /> : null}{needsTakeover ? copy("接管并打开", "Take control and open") : copy("打开", "Open")}</button>
      </form>
      {snap.error && !snap.readFailed ? <p className="mb-start-error" role="alert"><Icon name="alert" extra="sm" /><span>{snap.error}</span></p> : null}
      <p className="mb-start-hint">{unbound
        ? copy("网页属于某个对话。发出第一条消息后，就可以在这里打开网页，Agent 也会使用同一组网页。", "Pages belong to a chat. After the first message you can open pages here, and the Agent uses the same ones.")
        : full ? copy("标签数已达上限。关闭一些网页，或在浏览器设置里提高上限。", "Tab limit reached. Close some pages or raise the limit in browser settings.")
        : copy("可以直接输入本机开发地址。对话和终端里的本机链接也会在这里打开。", "Local development addresses work as typed. Local links in the chat and terminal open here too.")}</p>
      {others.length && !pageId ? <section className="mb-start-pages" aria-label={copy("此对话已打开的网页", "Pages open in this chat")}>
        <h3>{copy("此对话已打开的网页", "Open in this chat")}</h3>
        <ul>{others.map(page => {
          const address = splitAddress(page.url);
          return <li key={page.id}><button type="button" onClick={() => reveal(page)} data-tip={page.url}>
            <SiteMark page={page} /><span className="mb-start-page-title">{page.url === "about:blank" ? copy("新标签页", "New tab") : page.title || address.host}</span><span className="mb-start-page-host">{page.url === "about:blank" ? "" : address.host}</span>
          </button></li>;
        })}</ul>
      </section> : null}
    </div>
  </div>;
}

/** What sits in the page area when there is no live page to show. */
export function BrowserPageState({ kind, page, copy, busy, onRetry }: {
  kind: "loading" | "read-failed" | "released" | "failed" | "closed"; page?: ManagedBrowserPage | undefined; copy: Copy; busy?: boolean; onRetry?: (() => void) | undefined;
}) {
  const title = kind === "loading" ? copy("正在读取浏览器状态…", "Loading browser state…")
    : kind === "read-failed" ? copy("读取浏览器状态失败", "Couldn't load the browser")
    : kind === "released" ? copy("网页已释放", "Page released")
    : kind === "failed" ? page?.status === "crashed" ? copy("网页崩溃了", "The page crashed") : copy("网页加载失败", "The page didn't load")
    : copy("网页已关闭", "Page closed");
  const detail = kind === "released" ? copy("为节省内存，活页面已关闭；标签、登录状态和缩放都还在。重新加载会回到原来的地址。", "The live page was closed to save memory. The tab, sign-ins and zoom are kept; reloading returns to the same address.")
    : kind === "failed" ? page?.error || copy("重新加载后再试一次。", "Reload to try again.")
    : kind === "read-failed" ? copy("桌面端暂时没有响应。", "The desktop didn't respond.")
    : kind === "closed" ? copy("这个网页已在别处关闭。", "This page was closed elsewhere.") : "";
  return <div className={`mb-state is-${kind}`} role={kind === "failed" || kind === "read-failed" ? "alert" : "status"}>
    <div className="mb-state-mark" aria-hidden="true">{kind === "loading" ? <i className="mb-spinner" /> : <Icon name={kind === "failed" || kind === "read-failed" ? "alert" : kind === "released" ? "eye-off" : "globe"} />}</div>
    <strong>{title}</strong>
    {detail ? <p>{detail}</p> : null}
    {page && kind !== "closed" ? <span className="mb-state-url">{page.url}</span> : null}
    {onRetry ? <button type="button" className="btn small outline" disabled={busy} onClick={onRetry}><Icon name="refresh" extra="sm" />{kind === "read-failed" ? copy("重试", "Retry") : copy("重新加载", "Reload")}</button> : null}
  </div>;
}
