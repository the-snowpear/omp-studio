import { useEffect, useRef, useState, type RefObject } from "react";
import type { BrowserCapability, ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { MenuItem } from "../menus";
import { formatShortcut } from "../keyboard/shortcuts";
import { DockPopupButton } from "../dock/DockMenus";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { motionMs } from "../motion";
import type { BrowserSession, BrowserSessionSnapshot } from "./browserSessions";
import type { BrowserView } from "./BrowserViews";

export type Copy = (zh: string, en: string) => string;
export interface BrowserControlPresentation {
  control: "agent" | "waiting" | "human" | "other-window";
  available: boolean;
  reason?: string | undefined;
  viewer?: boolean | undefined;
  take(): void;
  return(): void;
  stop(): void;
}
/** Absence is only the old, explicitly local embedded read model; new native pages always use their descriptor. */
export function browserPageCapability(page: ManagedBrowserPage, capability: BrowserCapability): boolean {
  return page.descriptor ? page.descriptor.capabilities[capability] : capability !== "nativeViewer";
}

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
  const [draft, setDraft] = useState<string | null>(null), [focused, setFocused] = useState(false);
  const blank = page.url === "about:blank";
  useEffect(() => { if (!focused) setDraft(null); }, [page.url, focused]);
  const address = splitAddress(page.url), display = !focused && draft === null && !blank;
  const lead = page.status === "error" || page.status === "crashed" ? "alert" : address.secure ? "lock" : "globe";
  return <form className={`mb-omnibox${focused ? " is-focused" : ""}${human ? "" : " is-readonly"}`} data-status={page.status} onSubmit={event => {
    event.preventDefault(); const value = (draft ?? "").trim(); if (!human || !value) return;
    onNavigate(value); setDraft(null); inputRef.current?.blur();
  }}>
    <span className="mb-omnibox-lead" data-tip={address.secure ? copy("安全连接（HTTPS）", "Secure connection (HTTPS)") : address.local ? copy("本机地址", "Local address") : undefined}><Icon name={lead} extra="sm" /></span>
    <span className="mb-omnibox-field">
      <input ref={inputRef} className={`mb-omnibox-input${display ? " is-masked" : ""}`} aria-label={copy("浏览器地址", "Browser address")} inputMode="url" spellCheck={false} autoComplete="off"
        value={draft ?? (blank ? "" : page.url)} readOnly={!human} placeholder={copy("输入网址", "Enter an address")}
        data-tip={human ? undefined : copy("接管后可以输入网址", "Take control to enter an address")}
        onFocus={event => { setFocused(true); event.currentTarget.select(); }} onBlur={() => { setFocused(false); setDraft(null); }}
        onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setDraft(null); event.currentTarget.blur(); } }} />
      {display ? <span className="mb-omnibox-display" aria-hidden="true"><span className="mb-omnibox-host">{address.host}</span><span className="mb-omnibox-path">{address.rest}</span></span> : null}
    </span>
    {page.zoom !== 1 && browserPageCapability(page, "zoom") ? <button type="button" className="mb-omnibox-chip" disabled={!human} aria-label={copy(`缩放 ${Math.round(page.zoom * 100)}%，恢复为 100%`, `Zoom ${Math.round(page.zoom * 100)}%, reset to 100%`)} onClick={() => onZoom(1)}>{Math.round(page.zoom * 100)}%</button> : null}
    {spaceName ? <span className="mb-omnibox-chip is-space" data-tip={copy("此网页使用的浏览空间", "Browser space for this page")}>{spaceName}</span> : null}
  </form>;
}

/** Native control belongs to this tab/lease, while the legacy embedded adapter keeps its existing chat-wide control. */
export function BrowserControlToggle({ session, snap, copy, compact, native }: { session: BrowserSession; snap: BrowserSessionSnapshot; copy: Copy; compact: boolean; native?: BrowserControlPresentation | undefined }) {
  const control = native?.control ?? snap.state?.control ?? "agent", human = control === "human";
  const toHuman = snap.controlPending === "human" || control === "waiting", toAgent = snap.controlPending === "agent";
  const other = control === "other-window", disabled = native?.available === false || other;
  const devtools = !native && !!snap.state?.pages.some(page => page.devtools);
  return <div className={`seg mb-control${compact ? " is-compact" : ""}`} role="group" aria-label={copy("浏览器控制", "Browser control")}>
    <button type="button" data-who="agent" className={!human && !toHuman ? "active" : ""} aria-pressed={!human && !toHuman}
      disabled={disabled || !!(human && devtools) || toAgent}
      aria-label={human || toHuman ? copy("归还 Agent 控制", "Return control to Agent") : other ? copy("其他窗口正在控制", "Another window has control") : copy("Agent 正在控制", "Agent has control")}
      data-tip={disabled ? native?.reason ?? copy("其他窗口持有此页面租约", "Another window holds this page's lease") : devtools ? copy("先关闭 DevTools 再归还", "Close DevTools before returning control") : copy("归还接管；原生页面继续保留", "Return control; the native page stays open")}
      onClick={() => { if ((human || toHuman) && !devtools) { if (native) native.return(); else void session.setControl("agent"); } }}>
      {toAgent ? <i className="mb-spinner" aria-hidden="true" /> : <Icon name="bot" extra="sm" />}{compact ? null : <span>Agent</span>}
    </button>
    <button type="button" data-who="human" className={human ? "active" : ""} aria-pressed={human} aria-busy={toHuman || undefined} disabled={disabled || toHuman}
      aria-label={human ? copy("你正在控制", "You have control") : toHuman ? copy("正在等待 Agent 交出控制", "Waiting for the Agent to hand over") : copy("人工接管", "Take control")}
      data-tip={disabled ? native?.reason : toHuman ? copy("等当前原生动作结束后交给你", "Hands over after the current native action finishes") : copy("接管同一页面，不创建新标签", "Take over this same page without creating a tab")}
      onClick={() => { if (!human && !toHuman) { if (native) native.take(); else void session.setControl("human"); } }}>
      {toHuman ? <i className="mb-spinner" aria-hidden="true" /> : <Icon name="user" extra="sm" />}{compact ? null : <span>{copy("我", "Me")}</span>}
    </button>
  </div>;
}

export function BrowserMoreMenu({ session, snap, page, human, compact, copy, onFind, onView, onPick, native }: {
  session: BrowserSession; snap: BrowserSessionSnapshot; page: ManagedBrowserPage; human: boolean; compact: boolean; copy: Copy;
  onFind: () => void; onView: (view: BrowserView | "webmcp") => void; onPick: () => void; native?: BrowserControlPresentation | undefined;
}) {
  const document = useSurfaceDocument(), state = snap.state!;
  const embedded = !page.descriptor || page.descriptor.transport === "embedded";
  const canCreate = session.nativeAvailable || state.pages.length < state.settings.maxTabs && (human || !state.pages.length);
  const zoom = Math.round(page.zoom * 100), active = state.downloads.filter(download => download.state === "progressing").length;
  const humanOnly = human ? undefined : copy("接管后可用", "Take control first");
  const reason = (capability: BrowserCapability) => page.descriptor?.capabilities.reasons[capability] ?? humanOnly;
  const supports = (capability: BrowserCapability) => browserPageCapability(page, capability);
  return <DockPopupButton label={copy("更多浏览器选项", "More browser options")} icon="more" popupClassName="mb-menu">
    {close => <>
      <MenuItem icon="plus" kbd={formatShortcut({ key: "T" })} disabled={!canCreate} title={canCreate ? undefined : humanOnly} onClick={() => { void session.create("about:blank", { openerPageId: page.id, spaceId: page.spaceId, ...(embedded && session.nativeAvailable ? { app: "embedded" } : {}) }); close(); }}>{copy("新建标签页", "New tab")}</MenuItem>
      <MenuItem icon="search" kbd={formatShortcut({ key: "F" })} disabled={!human || !supports("find")} title={reason("find")} onClick={() => { onFind(); close(); }}>{copy("在页面中查找", "Find in page")}</MenuItem>
      {compact ? <>
        <MenuItem icon="cursor" disabled={page.devtools || !supports("pick")} title={reason("pick")} onClick={() => { onPick(); close(); }}>{snap.picking === page.id ? copy("停止选择元素", "Stop picking") : copy("选择页面元素", "Pick an element")}</MenuItem>
        <MenuItem icon="code" disabled={!supports("devtools")} title={reason("devtools")} onClick={() => { void session.execute({ action: "devtools", pageId: page.id }); close(); }}>{page.devtools ? copy("关闭开发者工具", "Close DevTools") : copy("开发者工具", "DevTools")}</MenuItem>
      </> : null}
      <div className="mb-menu-zoom" role="group" aria-label={copy("缩放", "Zoom")} title={reason("zoom")}>
        <Icon name="search" extra="sm" /><span>{copy("缩放", "Zoom")}</span>
        <button type="button" role="menuitem" className="icon-btn small" disabled={!human || !supports("zoom") || page.zoom <= 0.25} aria-label={copy("缩小", "Zoom out")} onClick={() => void session.execute({ action: "zoom", pageId: page.id, factor: Math.round((page.zoom - 0.1) * 100) / 100 })}><Icon name="minimize" extra="sm" /></button>
        <button type="button" role="menuitem" className="mb-menu-zoom-value" disabled={!human || !supports("zoom") || page.zoom === 1} aria-label={copy(`恢复 100%，当前 ${zoom}%`, `Reset to 100%, now ${zoom}%`)} onClick={() => void session.execute({ action: "zoom", pageId: page.id, factor: 1 })}>{supports("zoom") ? `${zoom}%` : "—"}</button>
        <button type="button" role="menuitem" className="icon-btn small" disabled={!human || !supports("zoom") || page.zoom >= 3} aria-label={copy("放大", "Zoom in")} onClick={() => void session.execute({ action: "zoom", pageId: page.id, factor: Math.round((page.zoom + 0.1) * 100) / 100 })}><Icon name="plus" extra="sm" /></button>
      </div>
      {supports("nativeViewer") ? <MenuItem icon="external" disabled={!human} title={humanOnly} onClick={() => { void session.execute({ action: "viewer", pageId: page.id, visible: !native?.viewer }); close(); }}>{native?.viewer ? copy("隐藏原生窗口", "Hide native window") : copy("原生窗口（同一页面）", "Native window (same view)")}</MenuItem> : null}
      <div className="menu-sep" />
      <MenuItem icon="copy" disabled={page.url === "about:blank"} onClick={() => { void document.defaultView?.navigator.clipboard.writeText(page.url); close(); }}>{copy("复制网址", "Copy address")}</MenuItem>
      <MenuItem icon="external" disabled={!/^https?:/iu.test(page.url)} title={copy("另开系统浏览器，不是当前标签的同页观察", "Opens a different system-browser page, not the observed tab")} onClick={() => { document.defaultView?.open(page.url, "_blank", "noopener,noreferrer"); close(); }}>{copy("在系统浏览器打开", "Open in system browser")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="layers" disabled={!embedded || !human || state.pages.length < 2} title={!embedded ? copy("原生标签请逐个关闭，遵循 owned / borrowed 生命周期", "Close native tabs individually, preserving owned / borrowed lifetimes") : humanOnly} onClick={() => { void session.execute({ action: "close-others", pageId: page.id }); close(); }}>{copy("关闭其他标签页", "Close other tabs")}</MenuItem>
      <MenuItem icon="eye-off" disabled={native ? !native.available : !state.pages.length} title={native ? copy("释放画面与接管；CLI 标签不关闭", "Release viewing and control; keep the CLI tab") : copy("关闭活页面以释放内存，标签和登录状态保留", "Free page memory; tabs and sign-ins stay")} onClick={() => { if (native) native.stop(); else void session.execute({ action: "release" }); close(); }}>{native ? copy("停止观察", "Stop viewing") : copy("释放此对话的网页", "Release this chat's pages")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="terminal" disabled={!supports("console")} title={reason("console")} onClick={() => { onView("console"); close(); }}>Console</MenuItem>
      <MenuItem icon="globe" disabled={!supports("network")} title={reason("network")} onClick={() => { onView("network"); close(); }}>Network</MenuItem>
      <MenuItem icon="download" disabled={!supports("downloads")} title={reason("downloads")} {...(embedded && active ? { hint: copy(`${active} 个进行中`, `${active} active`) } : {})} onClick={() => { onView("downloads"); close(); }}>{copy("下载", "Downloads")}</MenuItem>
      <MenuItem icon="code" disabled={!supports("webmcp")} title={reason("webmcp")} onClick={() => { onView("webmcp"); close(); }}>WebMCP</MenuItem>
      <MenuItem icon="settings" disabled={!supports("settings")} title={reason("settings")} onClick={() => { onView("settings"); close(); }}>{copy("浏览器设置", "Browser settings")}</MenuItem>
      <MenuItem icon="info" onClick={() => { onView("capabilities"); close(); }}>{copy("页面与能力", "Page and capabilities")}</MenuItem>
    </>}
  </DockPopupButton>;
}

export function BrowserToolbar({ session, snap, page, human, compact, copy, addressRef, demo = false, onFind, onView, native }: {
  session: BrowserSession; snap: BrowserSessionSnapshot; page: ManagedBrowserPage; human: boolean; compact: boolean; copy: Copy;
  addressRef: RefObject<HTMLInputElement | null>; demo?: boolean; onFind: () => void; onView: (view: BrowserView | "webmcp") => void; native?: BrowserControlPresentation | undefined;
}) {
  const busy = snap.busy.includes(page.id), loading = page.status === "loading", picking = snap.picking === page.id;
  const pick = () => { if (picking) void session.stopPicking(); else void session.startPicking(page.id); };
  const space = page.spaceId !== "shared" ? snap.state?.spaces.find(item => item.id === page.spaceId)?.name : undefined;
  const humanOnly = human ? undefined : copy("接管后可用", "Take control first");
  const tool = (label: string) => ({ "aria-label": label, "data-tip": label });
  const previous = useRef(loading), [settled, setSettled] = useState(false);
  useEffect(() => {
    const duration = motionMs("slower");
    if (previous.current && !loading && duration) { setSettled(true); const timer = setTimeout(() => setSettled(false), duration); previous.current = loading; return () => clearTimeout(timer); }
    previous.current = loading; setSettled(false); return undefined;
  }, [loading]);
  const cap = page.descriptor?.capabilities;
  return <div className="mb-toolbar">
    <div className="mb-nav">
      <button type="button" className="icon-btn" {...tool(copy("后退", "Back"))} disabled={!human || busy || !page.canGoBack || cap?.history === false} {...(human ? {} : { "data-tip": humanOnly })} onClick={() => void session.execute({ action: "back", pageId: page.id })}><Icon name="arrow-l" extra="sm" /></button>
      <button type="button" className="icon-btn" {...tool(copy("前进", "Forward"))} disabled={!human || busy || !page.canGoForward || cap?.history === false} {...(human ? {} : { "data-tip": humanOnly })} onClick={() => void session.execute({ action: "forward", pageId: page.id })}><Icon name="arrow-r" extra="sm" /></button>
      <button type="button" className="icon-btn" {...tool(loading ? copy("停止加载", "Stop loading") : copy("重新加载", "Reload"))} disabled={!human || busy || page.status === "released" || cap?.control === false} {...(human ? {} : { "data-tip": humanOnly })} onClick={() => void session.execute({ action: loading ? "stop" : "reload", pageId: page.id })}><Icon name={loading ? "x" : "refresh"} extra="sm" /></button>
    </div>
    <BrowserOmnibox page={page} human={human && cap?.control !== false} inputRef={addressRef} spaceName={space} copy={copy}
      onNavigate={url => void session.execute({ action: "navigate", pageId: page.id, url })} onZoom={factor => void session.execute({ action: "zoom", pageId: page.id, factor })} />
    <div className="mb-actions">
      {demo && !compact ? <span className="chip gray xs">{copy("演示", "Demo")}</span> : null}
      {page.descriptor && !compact ? <span className="chip gray xs mb-engine" data-tip={`${page.descriptor.engine} · ${page.descriptor.transport}\n${page.descriptor.targetId}\n${page.descriptor.ownership} · ${page.descriptor.ownerSessionId}`}>{page.descriptor.engine === "webkit" ? "WebKit" : page.descriptor.engine === "chromium" ? "Chromium" : copy("未知引擎", "Unknown engine")}</span> : null}
      {compact ? null : <>
        <button type="button" className={`icon-btn${picking ? " active" : ""}`} {...tool(picking ? copy("停止选择元素", "Stop picking elements") : copy("选择页面元素", "Pick a page element"))} aria-pressed={picking} disabled={page.devtools || page.status === "released" || cap?.pick === false} title={cap?.reasons.pick} onClick={pick}><Icon name="cursor" extra="sm" /></button>
        <button type="button" className={`icon-btn${page.devtools ? " active" : ""}`} {...tool(page.devtools ? copy("关闭开发者工具", "Close DevTools") : copy("开发者工具", "DevTools"))} aria-pressed={page.devtools} disabled={cap?.devtools === false} title={cap?.reasons.devtools} onClick={() => void session.execute({ action: "devtools", pageId: page.id })}><Icon name="code" extra="sm" /></button>
      </>}
      <BrowserControlToggle session={session} snap={snap} copy={copy} compact={compact} native={native} />
      <BrowserMoreMenu session={session} snap={snap} page={page} human={human} compact={compact} copy={copy} onFind={onFind} onView={onView} onPick={pick} native={native} />
    </div>
    <span className={`mb-loadbar${loading ? " is-loading" : settled ? " is-done" : ""}`} aria-hidden="true" />
  </div>;
}
