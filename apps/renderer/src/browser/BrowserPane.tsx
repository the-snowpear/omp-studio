import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { BrowserObservationEvent, BrowserObservationInput, BrowserObservationResultMap, StudioBrowserTab } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceEmpty } from "../workspaces/Workspace";
import { PREVIEW_BROWSER_TAB, PREVIEW_BROWSER_IMAGE } from "../preview/browserPreview";
import "./browser.css";

export function BrowserPane({ client, sessionId, available, visible, capabilities }: {
  client: StudioClient; sessionId?: string | undefined; available: boolean; visible: boolean; capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [tabs, setTabs] = useState<StudioBrowserTab[]>([]); const [selected, setSelected] = useState("");
  const [state, setState] = useState<Extract<BrowserObservationEvent, { kind: "state" }>>();
  const [frame, setFrame] = useState<Extract<BrowserObservationEvent, { kind: "frame" }>>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [observing, setObserving] = useState(false); const [url, setUrl] = useState("");
  const observation = useRef<string | undefined>(undefined); const epoch = useRef(0); const scope = useRef(""); const urlDirty = useRef(false); const picture = useRef<HTMLImageElement>(null);
  const chrome = globalThis.ompStudioChrome;
  const enabled = preview || (available && !!sessionId && capabilities?.capabilities.some(item => item.id === "browser.tabs.get" && item.grade !== "unavailable") === true);
  const canObserve = preview || (enabled && !!chrome?.attachBrowserObservation && capabilities?.capabilities.some(item => item.id === "browser.observe.prepare" && item.grade !== "unavailable") === true);
  const human = state?.control === "human";
  const detach = useCallback(() => { const id = observation.current; observation.current = undefined; if (id) void globalThis.ompStudioChrome?.detachBrowserObservation?.({ observationId: id }); setObserving(false); setFrame(undefined); setState(undefined); }, []);
  const send = useCallback(async (input: BrowserObservationInput) => {
    if (preview) { if (input.kind === "take" || input.kind === "release") setState(current => ({ kind: "state", observationId: "demo", tabId: PREVIEW_BROWSER_TAB.id, title: PREVIEW_BROWSER_TAB.title, url: PREVIEW_BROWSER_TAB.url, busy: false, frozen: false, ...current, control: input.kind === "take" ? "human" : "agent" })); return; }
    const id = observation.current; if (!id) return;
    try {
      const value = await globalThis.ompStudioChrome?.controlBrowserObservation?.({ observationId: id, input });
      if (!value?.ok && observation.current === id) setError(value?.message ?? (zh ? "浏览器控制不可用" : "Browser control unavailable"));
    } catch (cause) { if (observation.current === id) setError(hostErrorMessage(cause, zh ? "浏览器连接中断" : "Browser connection interrupted")); }
  }, [preview, zh]);
  useEffect(() => {
    epoch.current++; detach();
    const scopeKey = (sessionId ?? "") + ":" + preview;
    if (scope.current !== scopeKey) { scope.current = scopeKey; setTabs(preview ? [PREVIEW_BROWSER_TAB] : []); setSelected(preview ? PREVIEW_BROWSER_TAB.id : ""); urlDirty.current = false; }
    setError(""); setBusy(false);
    if (!visible || !enabled || document.hidden) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!preview && !document.hidden && sessionId) { const handle = await client.command("browser.tabs.get", { sessionId }); const value = (await waitReceipt<{ result: BrowserObservationResultMap["browser.tabs.get"] }>(client, handle.requestId)).result; if (active) { setTabs(value.tabs); setSelected(current => value.tabs.some(tab => tab.id === current) ? current : value.tabs[0]?.id ?? ""); } }
      } catch (cause) { if (active) setError(hostErrorMessage(cause, zh ? "浏览器目录读取失败" : "Cannot read browser targets")); }
      finally { if (active && !preview) timer = setTimeout(() => void poll(), 2000); }
    };
    const unsubscribe = chrome?.onBrowserObservation?.(event => {
      if (!active || observation.current !== event.observationId) return;
      if (event.kind === "frame") setFrame(event);
      else if (event.kind === "state") { setState(event); if (!urlDirty.current) setUrl(event.url); }
      else if (event.kind === "error") setError(event.message);
      else { observation.current = undefined; setObserving(false); setFrame(undefined); setState(undefined); }
    });
    const heartbeat = setInterval(() => { if (observation.current && !document.hidden) void send({ kind: "ping" }); }, 5000);
    const hide = () => { if (document.hidden) { epoch.current++; detach(); } }; document.addEventListener("visibilitychange", hide);
    void poll();
    return () => { active = false; epoch.current++; clearTimeout(timer); clearInterval(heartbeat); unsubscribe?.(); document.removeEventListener("visibilitychange", hide); detach(); };
  }, [client, sessionId, available, visible, enabled, preview, chrome, detach, send, zh]);
  const observe = async () => {
    const target = tabs.find(tab => tab.id === selected); if (!target?.observable || !canObserve || busy || !visible) return;
    const generation = ++epoch.current; detach(); setBusy(true); setError(""); urlDirty.current = false; setUrl(target.url);
    try {
      if (preview) { setObserving(true); setState({ kind: "state", observationId: "demo", tabId: target.id, title: target.title, url: target.url, busy: false, frozen: false, control: "agent" }); return; }
      const handle = await client.command("browser.observe.prepare", { sessionId: sessionId!, tabId: selected });
      const { result } = await waitReceipt<{ result: BrowserObservationResultMap["browser.observe.prepare"] }>(client, handle.requestId);
      if (generation !== epoch.current || !visible || document.hidden) return; observation.current = result.observationId;
      const attached = await chrome?.attachBrowserObservation?.({ observationId: result.observationId, sessionId: result.sessionId, tabId: result.tabId });
      if (generation !== epoch.current) { void chrome?.detachBrowserObservation?.({ observationId: result.observationId }); return; }
      if (!attached?.ok) throw new Error(attached?.message ?? "Desktop observation unavailable"); setObserving(true);
    } catch (cause) { if (generation === epoch.current) { detach(); setError(hostErrorMessage(cause, zh ? "无法观察此标签" : "Cannot observe this tab")); } }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  const coordinates = (x: number, y: number) => { const rect = picture.current?.getBoundingClientRect(); return rect && rect.width && rect.height ? { x: Math.max(0, Math.min(1, (x - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (y - rect.top) / rect.height)) } : undefined; };
  useEffect(() => {
    const image = picture.current; if (!image || !human || !frame) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); const point = coordinates(event.clientX, event.clientY); if (point) void send({ kind: "wheel", sequence: frame.sequence, ...point, deltaX: Math.max(-2048, Math.min(2048, event.deltaX)), deltaY: Math.max(-2048, Math.min(2048, event.deltaY)) }); };
    image.addEventListener("wheel", wheel, { passive: false }); return () => image.removeEventListener("wheel", wheel);
  }, [human, frame, send]);
  const selectedTab = tabs.find(tab => tab.id === selected);
  return <section className="browser-pane" aria-label={zh ? "浏览器观察" : "Browser observation"}>
    <div className="browser-toolbar"><select className="select" aria-label={zh ? "浏览器标签" : "Browser tab"} value={selected} disabled={!enabled || busy} onChange={event => { epoch.current++; detach(); setSelected(event.target.value); }}><option value="">{zh ? "选择 Runtime 标签" : "Select Runtime tab"}</option>{tabs.map(tab => <option value={tab.id} key={tab.id}>{tab.kind} · {tab.title || tab.name}</option>)}</select><button className="btn small primary" disabled={!selectedTab?.observable || !canObserve || busy} onClick={() => void observe()}>{busy ? "…" : zh ? "观察" : "Observe"}</button></div>
    {error ? <p role="alert" className="browser-error">{error}</p> : null}
    {!enabled || !tabs.length ? <WorkspaceEmpty icon="globe" title={zh ? "暂无可观察的浏览器" : "No observable browser"}>{!enabled ? zh ? "连接支持浏览器观察的 Runtime 后重试。" : "Connect a Runtime with browser observation support." : zh ? "OMP 打开浏览器后，其主代理和子代理的标签会出现在这里。" : "Tabs created by OMP and its subagents appear here."}</WorkspaceEmpty> : null}
    {selectedTab?.reason ? <p role="status">{selectedTab.reason}</p> : null}
    {observing ? <>
      <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); if (human) { urlDirty.current = false; void send({ kind: "navigate", url }).catch(cause => setError(String(cause))); } }}><input className="input" aria-label={zh ? "浏览器地址" : "Browser address"} value={url} readOnly={!human} onChange={event => { urlDirty.current = true; setUrl(event.target.value); }} /><button className="btn small outline" disabled={!human}>{zh ? "前往" : "Go"}</button></form>
      <div className="browser-toolbar"><span className="browser-status">{preview ? zh ? "演示 · " : "Demo · " : ""}{human ? zh ? "你正在控制" : "You have control" : state?.control === "waiting" ? zh ? "等待当前动作结束" : "Waiting for current action" : state?.control === "other-window" ? zh ? "其他窗口正在控制" : "Controlled by another window" : zh ? "观察模式" : "Observing"}{state?.frozen ? zh ? " · 页面已暂停" : " · Page frozen" : ""}</span><button className="btn small outline" disabled={state?.control === "other-window"} onClick={() => void send({ kind: human || state?.control === "waiting" ? "release" : "take" })}>{human || state?.control === "waiting" ? zh ? "归还控制" : "Return control" : zh ? "人工接管" : "Take control"}</button><button className="btn small outline" onClick={() => { epoch.current++; detach(); }}>{zh ? "停止观察" : "Stop viewing"}</button></div>
      <div className={`browser-picture${human ? " is-controlled" : ""}`} tabIndex={human ? 0 : -1} aria-label={zh ? "浏览器实时画面" : "Live browser image"} onKeyDown={event => { if (!human || !frame || event.nativeEvent.isComposing) return; event.preventDefault(); if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) void send({ kind: "text", sequence: frame.sequence, text: event.key }); else void send({ kind: "key", sequence: frame.sequence, key: event.key, code: event.code, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) }); }} onPaste={event => { if (human && frame) { event.preventDefault(); void send({ kind: "text", sequence: frame.sequence, text: event.clipboardData.getData("text/plain").slice(0, 16384) }); } }} onCompositionEnd={event => { if (human && frame) void send({ kind: "text", sequence: frame.sequence, text: event.data }); }}>
        {frame || preview ? <img ref={picture} alt={zh ? "当前浏览器画面" : "Current browser image"} draggable={false} src={preview ? PREVIEW_BROWSER_IMAGE : `data:image/jpeg;base64,${frame!.data}`} onLoad={event => { const image = event.currentTarget; if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 4_000_000) { setError(zh ? "画面超过资源限制" : "Frame exceeds the resource budget"); detach(); return; } if (!preview && frame) void send({ kind: "ack", sequence: frame.sequence }); }} onError={() => { setError(zh ? "浏览器画面无法解码" : "Browser frame could not be decoded"); detach(); }} onContextMenu={event => event.preventDefault()} onMouseDown={event => { if (!human || !frame) return; event.preventDefault(); event.currentTarget.parentElement?.focus(); const point = coordinates(event.clientX, event.clientY); if (point) void send({ kind: "click", sequence: frame.sequence, ...point, button: event.button === 2 ? "right" : "left" }); }} /> : <p>{zh ? "等待浏览器画面…" : "Waiting for browser frames…"}</p>}
      </div>
      <p className="browser-hint">{human ? zh ? "点击画面后可输入、滚动或粘贴。关闭面板会释放接管。" : "Click the image to type, scroll or paste. Closing the panel releases control." : zh ? "观看使用 OMP 的同一标签，不会打开另一份网页。" : "Viewing uses OMP's same tab and does not open another page."}</p>
    </> : null}
  </section>;
}
