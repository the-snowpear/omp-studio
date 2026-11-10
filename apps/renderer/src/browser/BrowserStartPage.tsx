import { useEffect, useRef, useState } from "react";
import type { ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
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
  const [working, setWorking] = useState(false);
  const state = snap.state;
  const human = state?.control === "human";
  const pending = snap.pendingLink;
  // The first page of a chat may be opened without a takeover; afterwards the user takes control first.
  const needsTakeover = !!state && !human && (!!pageId || state.pages.length > 0);
  const full = !!state && !pageId && state.pages.length >= state.settings.maxTabs;
  useEffect(() => { if (autoFocus) input.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useEffect(() => { if (pending) setValue(pending.url); }, [pending?.id]);
  const open = async (url: string) => {
    if (!session || !url.trim() || working) return;
    setWorking(true);
    try {
      if (needsTakeover && !await session.setControl("human")) return;
      const result = pageId ? await session.execute({ action: "navigate", pageId, url: url.trim() }) : await session.create(url.trim(), { linkKey: pending?.url === url.trim() ? pending.reuseKey : undefined });
      if (result) { setValue(""); if (pending) session.setPendingLink(null); }
    } finally { setWorking(false); }
  };
  const others = state?.pages.filter(page => page.id !== pageId) ?? [];
  const reveal = (page: ManagedBrowserPage) => {
    const panel = browserPagePanelId(session!.id, page.id);
    dock?.store.dispatch({ type: "open", panel });
    dock?.store.dispatch({ type: "browser-page-focus", panel });
  };
  const disabled = unbound || !state || working || full;
  return <div className="mb-start">
    <div className="mb-start-column">
      <div className="mb-start-mark" aria-hidden="true"><Icon name="globe" /></div>
      <h2 className="mb-start-title">{copy("新标签页", "New tab")}</h2>
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
