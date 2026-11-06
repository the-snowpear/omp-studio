import { useEffect, useRef, useState, type RefObject } from "react";
import type { ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { MenuItem } from "../menus";
import { formatShortcut } from "../keyboard/shortcuts";
import { DockPopupButton } from "../dock/DockMenus";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import type { BrowserSession, BrowserSessionSnapshot } from "./browserSessions";

export type Copy = (zh: string, en: string) => string;

/** Host stays readable while the path recedes, as in a browser's address bar. */
export function splitAddress(url: string): { host: string; rest: string; secure: boolean; local: boolean } {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/u.test(parsed.protocol)) return { host: url, rest: "", secure: false, local: false };
    const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u.test(parsed.hostname) || parsed.hostname.endsWith(".localhost");
    return { host: parsed.host, rest: `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`, secure: parsed.protocol === "https:", local };
  } catch { return { host: url, rest: "", secure: false, local: false }; }
}

export function BrowserOmnibox({ page, human, inputRef, spaceName, copy, onNavigate, onZoom }: {
  page: ManagedBrowserPage; human: boolean; inputRef: RefObject<HTMLInputElement | null>; spaceName?: string | undefined; copy: Copy;
  onNavigate: (url: string) => void; onZoom: (factor: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const blank = page.url === "about:blank";
  useEffect(() => { if (!focused) setDraft(null); }, [page.url, focused]);
  const address = splitAddress(page.url);
  const display = !focused && draft === null && !blank;
  const lead = page.status === "error" || page.status === "crashed" ? "alert" : address.secure ? "lock" : "globe";
  return <form className={`mb-omnibox${focused ? " is-focused" : ""}${human ? "" : " is-readonly"}`} data-status={page.status} onSubmit={event => {
    event.preventDefault();
    const value = (draft ?? "").trim();
    if (!human || !value) return;
    onNavigate(value);
    setDraft(null);
    inputRef.current?.blur();
  }}>
    <span className="mb-omnibox-lead" data-tip={address.secure ? copy("安全连接（HTTPS）", "Secure connection (HTTPS)") : address.local ? copy("本机地址", "Local address") : undefined}><Icon name={lead} extra="sm" /></span>
    <span className="mb-omnibox-field">
      <input ref={inputRef} className={`mb-omnibox-input${display ? " is-masked" : ""}`} aria-label={copy("浏览器地址", "Browser address")} inputMode="url" spellCheck={false} autoComplete="off"
        value={draft ?? (blank ? "" : page.url)} readOnly={!human} placeholder={copy("输入网址", "Enter an address")}
        data-tip={human ? undefined : copy("接管后可以输入网址", "Take control to enter an address")}
        onFocus={event => { setFocused(true); event.currentTarget.select(); }} onBlur={() => { setFocused(false); setDraft(null); }}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { setDraft(null); event.currentTarget.blur(); } }} />
      {display ? <span className="mb-omnibox-display" aria-hidden="true"><span className="mb-omnibox-host">{address.host}</span><span className="mb-omnibox-path">{address.rest}</span></span> : null}
    </span>
    {page.zoom !== 1 ? <button type="button" className="mb-omnibox-chip" disabled={!human} data-tip={copy("恢复为 100%", "Reset to 100%")} aria-label={copy(`缩放 ${Math.round(page.zoom * 100)}%，恢复为 100%`, `Zoom ${Math.round(page.zoom * 100)}%, reset to 100%`)} onClick={() => onZoom(1)}>{Math.round(page.zoom * 100)}%</button> : null}
    {spaceName ? <span className="mb-omnibox-chip is-space" data-tip={copy("此网页使用的浏览空间", "Browser space for this page")}>{spaceName}</span> : null}
  </form>;
}

/** Who drives the page. The handoff is the panel's one loud signal: "我" lights the page frame. */
export function BrowserControlToggle({ session, snap, copy, compact }: { session: BrowserSession; snap: BrowserSessionSnapshot; copy: Copy; compact: boolean }) {
  const control = snap.state?.control ?? "agent";
  const human = control === "human";
  const toHuman = snap.controlPending === "human" || control === "waiting";
  const toAgent = snap.controlPending === "agent";
  const devtools = !!snap.state?.pages.some(page => page.devtools);
  return <div className={`seg mb-control${compact ? " is-compact" : ""}`} role="group" aria-label={copy("浏览器控制", "Browser control")}>
    <button type="button" data-who="agent" className={!human && !toHuman ? "active" : ""} aria-pressed={!human && !toHuman}
      aria-disabled={(human && devtools) || toAgent || undefined}
      aria-label={human ? copy("归还 Agent 控制", "Return control to Agent") : copy("Agent 正在控制", "Agent has control")}
      data-tip={human ? devtools ? copy("先关闭 DevTools 再归还", "Close DevTools before returning control") : copy("交还给 Agent 继续操作", "Hand the page back to the Agent") : copy("Agent 正在使用这个网页", "The Agent is using this page")}
      onClick={() => { if (human && !devtools) void session.setControl("agent"); }}>
      {toAgent ? <i className="mb-spinner" aria-hidden="true" /> : <Icon name="bot" extra="sm" />}{compact ? null : <span>Agent</span>}
    </button>
    <button type="button" data-who="human" className={human ? "active" : ""} aria-pressed={human} aria-busy={toHuman || undefined}
      aria-label={human ? copy("你正在控制", "You have control") : toHuman ? copy("正在等待 Agent 交出控制", "Waiting for the Agent to hand over") : copy("人工接管", "Take control")}
      data-tip={human ? copy("你正在操作这个网页", "You are operating this page") : toHuman ? copy("等 Agent 当前步骤结束后交给你", "Hands over after the Agent's current step") : copy("接管后可以直接操作网页", "Take control to use the page yourself")}
      onClick={() => { if (!human && !toHuman) void session.setControl("human"); }}>
      {toHuman ? <i className="mb-spinner" aria-hidden="true" /> : <Icon name="user" extra="sm" />}{compact ? null : <span>{copy("我", "Me")}</span>}
    </button>
  </div>;
}

export function BrowserMoreMenu({ session, snap, page, human, compact, copy, onFind, onView, onPick }: {
  session: BrowserSession; snap: BrowserSessionSnapshot; page: ManagedBrowserPage; human: boolean; compact: boolean; copy: Copy;
  onFind: () => void; onView: (view: "downloads" | "settings") => void; onPick: () => void;
}) {
  const document = useSurfaceDocument();
  const state = snap.state!;
  const canCreate = state.pages.length < state.settings.maxTabs && (human || !state.pages.length);
  const zoom = Math.round(page.zoom * 100);
  const active = state.downloads.filter(download => download.state === "progressing").length;
  const humanOnly = human ? undefined : copy("接管后可用", "Take control first");
  return <DockPopupButton label={copy("更多浏览器选项", "More browser options")} icon="more" popupClassName="mb-menu">
    {close => <>
      <MenuItem icon="plus" kbd={formatShortcut({ key: "T" })} disabled={!canCreate} title={canCreate ? undefined : human ? copy("标签数已达上限", "Tab limit reached") : humanOnly} onClick={() => { void session.create("about:blank", { openerPageId: page.id, spaceId: page.spaceId }); close(); }}>{copy("新建标签页", "New tab")}</MenuItem>
      <MenuItem icon="search" kbd={formatShortcut({ key: "F" })} disabled={!human} title={humanOnly} onClick={() => { onFind(); close(); }}>{copy("在页面中查找", "Find in page")}</MenuItem>
      {compact ? <>
        <MenuItem icon="cursor" disabled={page.devtools} onClick={() => { onPick(); close(); }}>{snap.picking === page.id ? copy("停止选择元素", "Stop picking") : copy("选择页面元素", "Pick an element")}</MenuItem>
        <MenuItem icon="code" onClick={() => { void session.execute({ action: "devtools", pageId: page.id }); close(); }}>{page.devtools ? copy("关闭开发者工具", "Close DevTools") : copy("开发者工具", "DevTools")}</MenuItem>
      </> : null}
      <div className="mb-menu-zoom" role="group" aria-label={copy("缩放", "Zoom")}>
        <Icon name="search" extra="sm" /><span>{copy("缩放", "Zoom")}</span>
        <button type="button" role="menuitem" className="icon-btn small" disabled={!human || page.zoom <= 0.25} aria-label={copy("缩小", "Zoom out")} onClick={() => void session.execute({ action: "zoom", pageId: page.id, factor: Math.round((page.zoom - 0.1) * 100) / 100 })}><Icon name="minimize" extra="sm" /></button>
        <button type="button" role="menuitem" className="mb-menu-zoom-value" disabled={!human || page.zoom === 1} aria-label={copy(`恢复 100%，当前 ${zoom}%`, `Reset to 100%, now ${zoom}%`)} onClick={() => void session.execute({ action: "zoom", pageId: page.id, factor: 1 })}>{zoom}%</button>
        <button type="button" role="menuitem" className="icon-btn small" disabled={!human || page.zoom >= 3} aria-label={copy("放大", "Zoom in")} onClick={() => void session.execute({ action: "zoom", pageId: page.id, factor: Math.round((page.zoom + 0.1) * 100) / 100 })}><Icon name="plus" extra="sm" /></button>
      </div>
      <div className="menu-sep" />
      <MenuItem icon="copy" disabled={page.url === "about:blank"} onClick={() => { void document.defaultView?.navigator.clipboard.writeText(page.url); close(); }}>{copy("复制网址", "Copy address")}</MenuItem>
      <MenuItem icon="external" disabled={!/^https?:/iu.test(page.url)} onClick={() => { document.defaultView?.open(page.url, "_blank", "noopener,noreferrer"); close(); }}>{copy("在系统浏览器打开", "Open in system browser")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="layers" disabled={!human || state.pages.length < 2} title={humanOnly} onClick={() => { void session.execute({ action: "close-others", pageId: page.id }); close(); }}>{copy("关闭其他标签页", "Close other tabs")}</MenuItem>
      <MenuItem icon="eye-off" disabled={!state.pages.length} title={copy("关闭活页面以释放内存，标签和登录状态保留", "Free page memory; tabs and sign-ins stay")} onClick={() => { void session.execute({ action: "release" }); close(); }}>{copy("释放此对话的网页", "Release this chat's pages")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="download" {...(active ? { hint: copy(`${active} 个进行中`, `${active} active`) } : state.downloads.length ? { hint: String(state.downloads.length) } : {})} onClick={() => { onView("downloads"); close(); }}>{copy("下载", "Downloads")}</MenuItem>
      <MenuItem icon="settings" onClick={() => { onView("settings"); close(); }}>{copy("浏览器设置", "Browser settings")}</MenuItem>
    </>}
  </DockPopupButton>;
}

export function BrowserToolbar({ session, snap, page, human, compact, copy, addressRef, demo = false, onFind, onView }: {
  session: BrowserSession; snap: BrowserSessionSnapshot; page: ManagedBrowserPage; human: boolean; compact: boolean; copy: Copy;
  addressRef: RefObject<HTMLInputElement | null>; demo?: boolean; onFind: () => void; onView: (view: "downloads" | "settings") => void;
}) {
  const busy = snap.busy.includes(page.id);
  const loading = page.status === "loading";
  const picking = snap.picking === page.id;
  const pick = () => { if (picking) void session.stopPicking(); else void session.startPicking(page.id); };
  const space = page.spaceId !== "shared" ? snap.state?.spaces.find(item => item.id === page.spaceId)?.name : undefined;
  const humanOnly = human ? undefined : copy("接管后可用", "Take control first");
  const tool = (label: string) => ({ "aria-label": label, "data-tip": label });
  const previous = useRef(loading);
  const [settled, setSettled] = useState(false);
  // The bar finishes its sweep once after loading, instead of vanishing mid-stride.
  useEffect(() => { if (previous.current && !loading) { setSettled(true); const timer = setTimeout(() => setSettled(false), 360); previous.current = loading; return () => clearTimeout(timer); } previous.current = loading; return undefined; }, [loading]);
  return <div className="mb-toolbar">
    <div className="mb-nav">
      <button type="button" className="icon-btn" {...tool(copy("后退", "Back"))} disabled={!human || busy || !page.canGoBack} {...(human ? {} : { "data-tip": humanOnly })} onClick={() => void session.execute({ action: "back", pageId: page.id })}><Icon name="arrow-l" extra="sm" /></button>
      <button type="button" className="icon-btn" {...tool(copy("前进", "Forward"))} disabled={!human || busy || !page.canGoForward} {...(human ? {} : { "data-tip": humanOnly })} onClick={() => void session.execute({ action: "forward", pageId: page.id })}><Icon name="arrow-r" extra="sm" /></button>
      <button type="button" className="icon-btn" {...tool(loading ? copy("停止加载", "Stop loading") : copy("重新加载", "Reload"))} disabled={!human || busy || page.status === "released"} {...(human ? {} : { "data-tip": humanOnly })}
        onClick={() => void session.execute({ action: loading ? "stop" : "reload", pageId: page.id })}><Icon name={loading ? "x" : "refresh"} extra="sm" /></button>
    </div>
    <BrowserOmnibox page={page} human={human} inputRef={addressRef} spaceName={space} copy={copy}
      onNavigate={url => void session.execute({ action: "navigate", pageId: page.id, url })} onZoom={factor => void session.execute({ action: "zoom", pageId: page.id, factor })} />
    <div className="mb-actions">
      {demo && !compact ? <span className="chip gray xs">{copy("演示", "Demo")}</span> : null}
      {compact ? null : <>
        <button type="button" className={`icon-btn${picking ? " active" : ""}`} {...tool(picking ? copy("停止选择元素", "Stop picking elements") : copy("选择页面元素", "Pick a page element"))} aria-pressed={picking} disabled={page.devtools || page.status === "released"} onClick={pick}><Icon name="cursor" extra="sm" /></button>
        <button type="button" className={`icon-btn${page.devtools ? " active" : ""}`} {...tool(page.devtools ? copy("关闭开发者工具", "Close DevTools") : copy("开发者工具", "DevTools"))} aria-pressed={page.devtools} onClick={() => void session.execute({ action: "devtools", pageId: page.id })}><Icon name="code" extra="sm" /></button>
      </>}
      <BrowserControlToggle session={session} snap={snap} copy={copy} compact={compact} />
      <BrowserMoreMenu session={session} snap={snap} page={page} human={human} compact={compact} copy={copy} onFind={onFind} onView={onView} onPick={pick} />
    </div>
    <span className={`mb-loadbar${loading ? " is-loading" : settled ? " is-done" : ""}`} aria-hidden="true" />
  </div>;
}
