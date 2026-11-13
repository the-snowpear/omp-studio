import type { StudioClient } from "@omp-studio/client-contract";
import { WebMcpPane } from "./WebMcpPane";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { BrowserElementReference, ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { useSurfaceChrome, useSurfaceDocument } from "../dock/SurfaceContext";
import { usePreviewMode } from "../preview/PreviewContext";
import { ManagedBrowserDemoPage } from "../preview/ManagedBrowserDemoPage";
import { browserHub, useBrowserSession, type BrowserSession, type BrowserSessionSnapshot } from "./browserSessions";
import { BrowserControlToggle, BrowserToolbar, browserPageCapability, splitAddress, type BrowserControlPresentation, type Copy } from "./BrowserToolbar";
import { BrowserPageState, BrowserStartPage } from "./BrowserStartPage";
import { BrowserReferenceTray } from "./BrowserReferenceTray";
import { BrowserViews, type BrowserView } from "./BrowserViews";
import { useBrowserPresentation } from "./useBrowserPresentation";
import { useBrowserWatch, useNativeBrowserObservation } from "./useNativeBrowserObservation";
import { NativeBrowserFrame } from "./NativeBrowserFrame";
import "./managedBrowser.css";

export function useBrowserCopy(): Copy {
  const { resolvedLanguage } = useI18n();
  return useCallback((zh: string, en: string) => resolvedLanguage === "zh" ? zh : en, [resolvedLanguage]);
}

export function useChatBrowser(sessionId: string | undefined, nativeClient?: StudioClient): { session: BrowserSession | null; snap: BrowserSessionSnapshot } {
  const { preview } = usePreviewMode();
  const api = useSurfaceChrome()?.managedBrowser;
  const hub = browserHub(preview, api, nativeClient);
  const session = useMemo(() => hub && sessionId ? hub.session(sessionId) : null, [hub, sessionId]);
  return { session, snap: useBrowserSession(session) };
}

function Bars({ session, snap, pageId, copy, find, findInput, onFind }: {
  session: BrowserSession; snap: BrowserSessionSnapshot; pageId: string | undefined; copy: Copy;
  find: string | null; findInput: RefObject<HTMLInputElement | null>; onFind: (value: string | null) => void;
}) {
  const search = (forward: boolean) => { if (pageId && find) void session.execute({ action: "find", pageId, text: find, forward }); };
  const close = () => { if (pageId) void session.execute({ action: "find", pageId, text: "" }); onFind(null); };
  return <>
    {pageId && snap.picking === pageId ? <div className="mb-bar is-picking" role="status">
      <Icon name="cursor" extra="sm" /><span>{copy("点击网页中的元素即可选中，可以连续选择多个；按 Esc 结束。", "Click elements on the page to select them, one after another. Press Esc to finish.")}</span>
      <button type="button" className="btn small" onClick={() => void session.stopPicking()}>{copy("结束选择", "Done")}</button>
    </div> : null}
    {pageId && find !== null ? <form className="mb-bar is-find" onSubmit={event => { event.preventDefault(); search(true); }}>
      <Icon name="search" extra="sm" />
      <input ref={findInput} className="mb-find-input" aria-label={copy("在页面中查找", "Find in page")} placeholder={copy("在页面中查找", "Find in page")} value={find}
        onChange={event => onFind(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); } else if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); search(false); } }} />
      <button type="button" className="icon-btn small" aria-label={copy("上一个", "Previous")} data-tip={copy("上一个", "Previous")} disabled={!find} onClick={() => search(false)}><Icon name="chevron-u" extra="sm" /></button>
      <button type="button" className="icon-btn small" aria-label={copy("下一个", "Next")} data-tip={copy("下一个", "Next")} disabled={!find} onClick={() => search(true)}><Icon name="chevron-d" extra="sm" /></button>
      <button type="button" className="icon-btn small" aria-label={copy("关闭查找", "Close find")} data-tip={copy("关闭查找", "Close find")} onClick={close}><Icon name="x" extra="sm" /></button>
    </form> : null}
    {snap.error && snap.state ? <div className="mb-bar is-error" role="alert">
      <Icon name="alert" extra="sm" /><span>{snap.error}</span>
      <button type="button" className="icon-btn small" aria-label={copy("关闭错误提示", "Dismiss error")} onClick={() => session.dismissError()}><Icon name="x" extra="sm" /></button>
    </div> : null}
  </>;
}

/** What shows through when the native page is hidden (a menu over it) or not drawn yet. */
function Placeholder({ page, copy }: { page: ManagedBrowserPage; copy: Copy }) {
  const address = splitAddress(page.url);
  return <div className="mb-placeholder" aria-hidden="true">
    {page.favicon ? <img src={page.favicon} alt="" draggable={false} /> : <Icon name="globe" />}
    <strong>{page.title && page.title !== page.url ? page.title : address.host}</strong>
    <span>{page.status === "loading" ? copy("正在加载…", "Loading…") : address.host}</span>
  </div>;
}

/** One web page of a chat, shown in its own dock tab. */
export function ManagedBrowserPane({ client, nativeClient, sessionId, pageId, visible, width = 0, foreign = false, onReferences, onActivate }: {
  client?: StudioClient | undefined; nativeClient?: StudioClient | undefined; sessionId: string; pageId: string; visible: boolean; width?: number; foreign?: boolean;
  onReferences?: ((references: BrowserElementReference[]) => void) | undefined; onActivate?: (() => void) | undefined;
}) {
  const { preview, marks } = usePreviewMode();
  const copy = useBrowserCopy();
  const { session, snap } = useChatBrowser(sessionId, nativeClient);
  useBrowserWatch(session, visible);
  const page = snap.state?.pages.find(item => item.id === pageId);
  const api = useSurfaceChrome()?.managedBrowser, document = useSurfaceDocument();
  const surfaceId = useId();
  const viewport = useRef<HTMLDivElement>(null), address = useRef<HTMLInputElement>(null), findInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<BrowserView | "page" | "webmcp">("page");
  const [find, setFind] = useState<string | null>(null);
  const nativePage = !!page?.descriptor && page.descriptor.transport !== "embedded";
  const inspect = view === "console" || view === "network" || view === "downloads" ? view : undefined;
  const native = useNativeBrowserObservation({ client: nativeClient, session, page, visible: visible && nativePage && (view === "page" || !!inspect), capture: view === "page", inspection: inspect });
  const human = nativePage ? native.state?.control === "human" : snap.state?.control === "human";
  const nativeControl: BrowserControlPresentation | undefined = nativePage ? { control: native.state?.control ?? "agent", available: native.available && !native.connecting && !native.paused && !!native.state && page!.descriptor!.capabilities.control,
    reason: page!.descriptor!.capabilities.reasons.control ?? copy("先连接同页观察，接管会等待原生动作结束", "Connect same-page viewing first; takeover waits for the native action"), viewer: native.viewer,
    take: () => void native.execute({ action: "take" }), return: () => void native.execute({ action: "return" }), stop: () => void native.execute({ action: "release" }) } : undefined;
  const blank = !nativePage && page?.url === "about:blank" && !page.opener?.popup;
  const drawable = !!page && view === "page" && page.status !== "crashed" && page.status !== "error" && !blank;
  useBrowserPresentation({ api: preview || nativePage ? undefined : api, document, viewport, sessionId, surfaceId, pageId: page?.id ?? null, visible: visible && drawable, onError: message => session?.reportError(message) });
  const compact = width > 0 && width < 560;
  const shortcut = snap.shortcut;
  useEffect(() => {
    if (!shortcut || shortcut.pageId !== pageId) return;
    setView("page");
    if (shortcut.action === "address") requestAnimationFrame(() => { address.current?.focus(); address.current?.select(); });
    else setFind(value => value ?? "");
  }, [shortcut?.id]);
  useEffect(() => { if (find !== null) findInput.current?.focus(); }, [find !== null]);
  useEffect(() => {
    if (!session || snap.picking !== pageId) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") void session.stopPicking(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [snap.picking, pageId, session, document]);
  let content;
  if (!session) content = <BrowserPageState kind="read-failed" copy={copy} />;
  else if (!snap.state) content = <BrowserPageState kind={snap.readFailed ? "read-failed" : "loading"} copy={copy} {...(snap.readFailed ? { onRetry: () => void session.read() } : {})} />;
  else if (!page) content = <BrowserPageState kind="closed" copy={copy} />;
  else if (view === "webmcp") content = <WebMcpPane client={client} sessionId={sessionId} pageId={pageId} documentId={page.documentId} agentControl={nativePage ? !native.state || native.state.control === "agent" : snap.state.control === "agent"} visible={visible} capability={page.descriptor?.capabilities.webmcp} reason={page.descriptor?.capabilities.reasons.webmcp} copy={copy} onBack={() => setView("page")} />;
  else if (view !== "page") content = <BrowserViews view={view} session={session} snap={snap} page={page} inspection={native.inspection} inspectionBusy={native.connecting} inspectionError={native.error} onRefresh={native.refreshInspection} visible={visible} copy={copy} onBack={() => setView("page")} />;
  else if (nativePage && page.descriptor?.transport === "none") content = <div className="mb-state" role="status"><strong>{copy("此原生引擎没有同页呈现通道", "This native engine has no same-page display transport")}</strong><p>{page.descriptor.capabilities.reasons.observe}</p><span className="mb-state-url">{page.url}</span></div>;
  else if (nativePage && !native.available) content = <div className="mb-state" role="status"><strong>{copy("当前连接无法显示同页画面", "Same-page display is unavailable on this connection")}</strong><p>{page.descriptor?.capabilities.reasons.observe ?? copy("此连接没有本机私有观察通道；原生标签仍保留，不会另开网页。", "This connection has no local private observation channel. The native tab stays open and is not replaced.")}</p></div>;
  else if (nativePage) content = <NativeBrowserFrame frames={native.frames} state={native.state} preview={preview} connecting={native.connecting} paused={native.paused} error={native.error} copy={copy} resume={native.resume} acknowledge={native.acknowledge} input={native.input} onDecodeError={() => void native.execute({ action: "release" })} onAddress={() => { address.current?.focus(); address.current?.select(); }} />;
  else if (blank) content = <BrowserStartPage session={session} snap={snap} copy={copy} pageId={page.id} autoFocus={visible} />;
  else if (page.status === "crashed" || page.status === "error") content = <BrowserPageState kind="failed" page={page} copy={copy} busy={snap.busy.includes(page.id)}
    onRetry={() => void (async () => { if (!human && !await session.setControl("human")) return; void session.execute({ action: "reload", pageId: page.id }); })()} />;
  else if (preview && page.status === "released") content = <BrowserPageState kind="released" page={page} copy={copy} onRetry={() => void session.select(page.id)} />;
  else if (preview) content = page.status === "loading" ? <Placeholder page={page} copy={copy} /> : <ManagedBrowserDemoPage page={page} picking={snap.picking === page.id} interactive={human}
    hint={marks && snap.picking === page.id ? copy("演示：点击按钮或段落即可选中，写好备注后放进输入框。", "Demo: click a button or paragraph to select it, add a note, then send it to the composer.") : null}
    onPick={pick => session.addReference({ id: `preview-${crypto.randomUUID()}`, pageId: page.id, url: page.url, title: page.title, selector: pick.selector, frameUrl: page.url, tagName: pick.tagName, text: pick.text, note: "", rect: pick.rect, capturedAt: new Date().toISOString() })} />;
  // A restored page loads as soon as it is shown and covers this; one released on purpose waits for Reload.
  else content = page.status === "released" ? <BrowserPageState kind="released" page={page} copy={copy} onRetry={() => void session.select(page.id)} /> : <Placeholder page={page} copy={copy} />;
  return <section className={`managed-browser${human && drawable ? " is-human" : ""}`} hidden={!visible} aria-label={copy("对话浏览器", "Chat browser")}
    onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    {session && page && view === "page" ? <BrowserToolbar session={session} snap={snap} page={page} human={human} compact={compact} copy={copy} addressRef={address}
      onFind={() => setFind(value => value ?? "")} onView={setView} demo={preview && marks} native={nativeControl} /> : null}
    {session ? <Bars session={session} snap={snap} pageId={view === "page" ? page?.id : undefined} copy={copy} find={find} findInput={findInput} onFind={setFind} /> : null}
    {nativePage && view === "page" && (native.error || native.state?.control === "waiting" || native.state?.control === "other-window") ? <div className={`mb-bar${native.error ? " is-error" : ""}`} role={native.error ? "alert" : "status"}><span>{native.error || (native.state?.control === "waiting" ? copy("等待当前原生动作结束，再接管同一页面。", "Waiting for the current native action before taking this same page.") : copy("其他窗口持有此原生页面的接管租约。", "Another window holds the control lease for this native page."))}</span></div> : null}
    {view === "page" && page?.descriptor?.notices?.length ? <div className="mb-bar" role="status"><span>{page.descriptor.notices.join(" · ")}</span></div> : null}
    <div className="mb-stage"><div className="mb-viewport" ref={viewport} role="region" aria-label={copy("浏览器页面", "Browser page")}>{content}</div></div>
    {session && page && view === "page" && browserPageCapability(page, "pick") ? <BrowserReferenceTray session={session} snap={snap} page={page} copy={copy} foreign={foreign} onReferences={onReferences} /> : null}
  </section>;
}

/** The Browser tool itself: a new-tab page for the chat, plus downloads and settings. */
export function BrowserStartPanel({ nativeClient, sessionId, visible, unbound = false }: { nativeClient?: StudioClient | undefined; sessionId: string | undefined; visible: boolean; unbound?: boolean }) {
  const { preview, marks } = usePreviewMode();
  const copy = useBrowserCopy();
  const { session, snap } = useChatBrowser(unbound ? undefined : sessionId, nativeClient);
  useBrowserWatch(session, visible);
  const [view, setView] = useState<BrowserView | "page">("page");
  const state = snap.state;
  return <section className="managed-browser is-start" hidden={!visible} aria-label={copy("对话浏览器", "Chat browser")}>
    {session && state && view === "page" ? <div className="mb-toolbar is-start">
      <span className="mb-toolbar-title">{copy("浏览器", "Browser")}</span>
      {preview && marks ? <span className="chip gray xs">{copy("演示", "Demo")}</span> : null}
      <div className="mb-actions">
        {state.pages.length && !session.nativeAvailable ? <BrowserControlToggle session={session} snap={snap} copy={copy} compact={false} /> : null}
        {session.embeddedAvailable ? <><button type="button" className="icon-btn" aria-label={copy("Embedded 下载", "Embedded downloads")} data-tip={copy("Studio embedded 下载；原生下载在各页面中查看", "Studio embedded downloads; native downloads belong to each page")} onClick={() => setView("downloads")}><Icon name="download" extra="sm" /></button>
        <button type="button" className="icon-btn" aria-label={copy("Embedded 浏览器设置", "Embedded browser settings")} data-tip={copy("仅作用于明确选择的 Studio embedded adapter", "Only applies to the explicitly selected Studio embedded adapter")} onClick={() => setView("settings")}><Icon name="settings" extra="sm" /></button></> : null}
      </div>
    </div> : null}
    <div className="mb-stage"><div className="mb-viewport" role="region" aria-label={copy("新标签页", "New tab")}>
      {session && state && view !== "page" ? <BrowserViews view={view} session={session} snap={snap} copy={copy} onBack={() => setView("page")} />
        : session && !state ? <BrowserPageState kind={snap.readFailed ? "read-failed" : "loading"} copy={copy} {...(snap.readFailed ? { onRetry: () => void session.read() } : {})} />
        : <BrowserStartPage session={session} snap={snap} copy={copy} unbound={unbound || !session} autoFocus={visible && !!snap.pendingLink} />}
    </div></div>
  </section>;
}
