import { ExtensionLinksProvider } from "./ExtensionLinks";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ShellVizLayer, ShellVizPreferences, ShellVizPresentation, ShellVizRow } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewShellPresentation } from "../preview/runtimeViewsPreview";
import { useI18n } from "../i18n";
import { ChunkedRows, ChunkedText } from "./textChunks";
import "./shellView.css";

export interface RuntimeToolScope { client?: Pick<StudioClient, "query"> | null | undefined; actions?: Pick<StudioClient, "command" | "subscribe"> | null | undefined; sessionId?: string | undefined; sourceSessionId?: string | undefined; agentId?: string | undefined; enabled?: boolean | undefined; }
const RuntimeToolContext = createContext<RuntimeToolScope>({});
export function RuntimeToolProvider({ children, ...scope }: RuntimeToolScope & { children: ReactNode }) {
  const value = useMemo(() => scope, [scope.client, scope.actions, scope.sessionId, scope.sourceSessionId, scope.agentId, scope.enabled]);
  return <RuntimeToolContext.Provider value={value}><ExtensionLinksProvider {...scope}>{children}</ExtensionLinksProvider></RuntimeToolContext.Provider>;
}
export const initialShellPreferences = (): ShellVizPreferences => ({ view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] });

export function ShellView({ toolCallId, running, maxRows }: { toolCallId: string; running: boolean; maxRows: number }) {
  const scope = useContext(RuntimeToolContext), { preview, marks } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(false), [visible, setVisible] = useState(false), [preferences, setPreferences] = useState(initialShellPreferences);
  const [view, setView] = useState<ShellVizPresentation>(), [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null), presentedPreferences = useRef<ShellVizPreferences | undefined>(undefined);
  useEffect(() => { setVisible(false); const element = host.current; if (!open || !element || (!scope.client && !preview)) return; const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting))); observer.observe(element); return () => observer.disconnect(); }, [open, scope.client, preview]);
  useEffect(() => {
    if (!open || !visible || preview || scope.enabled === false || !scope.client || !scope.sessionId) return;
    const client = scope.client, input = { sessionId: scope.sessionId, toolCallId, ...(scope.sourceSessionId ? { sourceSessionId: scope.sourceSessionId } : {}), ...(scope.agentId ? { agentId: scope.agentId } : {}) };
    return () => { void client.query("shell.view.release", input).catch(() => {}); };
  }, [open, visible, preview, scope.enabled, scope.client, scope.sessionId, scope.sourceSessionId, scope.agentId, toolCallId]);
  useEffect(() => {
    if (!open || !visible || scope.enabled === false) return;
    presentedPreferences.current = undefined;
    if (preview) { presentedPreferences.current = preferences; setView(previewShellPresentation(preferences)); setError(""); return; }
    if (!scope.client || !scope.sessionId) { setError(zh ? "需要已连接的 Runtime" : "A connected Runtime is required"); return; }
    const ownerDocument = host.current!.ownerDocument;
    const input = { sessionId: scope.sessionId, toolCallId, ...(scope.sourceSessionId ? { sourceSessionId: scope.sourceSessionId } : {}), ...(scope.agentId ? { agentId: scope.agentId } : {}) };
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (ownerDocument.hidden) return;
      try {
        const result = await scope.client!.query("shell.view.read", { ...input, preferences });
        if (alive) { presentedPreferences.current = preferences; setView(result.presentation); setError(result.available ? "" : result.reason ?? "Execution trace unavailable"); }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (alive && !ownerDocument.hidden && running && preferences.cursor === undefined) timer = setTimeout(() => void read(), 400); }
    };
    const visibility = () => { clearTimeout(timer); if (ownerDocument.hidden) void scope.client!.query("shell.view.release", input).catch(() => {}); else void read(); };
    ownerDocument.addEventListener("visibilitychange", visibility);
    void read();
    return () => { alive = false; clearTimeout(timer); ownerDocument.removeEventListener("visibilitychange", visibility); };
  }, [scope, toolCallId, running, open, visible, preferences, preview, zh]);
  useEffect(() => {
    if (!preferences.playing || !view || !open || !visible || host.current?.ownerDocument.hidden || presentedPreferences.current !== preferences) return;
    const timer = setTimeout(() => setPreferences(current => {
      const cursor = Math.min(view.timeline.length, (current.cursor ?? 0) + 1);
      return { ...current, cursor, playing: cursor < view.timeline.length };
    }), 250 / preferences.speed);
    return () => clearTimeout(timer);
  }, [preferences, view, open, visible]);
  function rows(items: ShellVizRow[]) { return <div className="shell-view-code"><ChunkedRows count={Math.min(items.length, maxRows)} renderRow={index => { const row = items[index]!; return <div className="shell-view-row" key={row.id} data-state={row.state} style={{ paddingInlineStart: `${row.depth}ch` }}>{row.segments.map((segment, i) => <span key={i} className={`shell-token ${segment.style ?? ""}`} data-state={segment.state} data-tip={segment.tip} onClick={() => segment.node && setPreferences(current => ({ ...current, selectedNode: segment.node! }))}>{segment.text}</span>)}{row.annotations?.map(value => <span className="shell-view-value" key={`${value.scopeId}:${value.name}`} data-tip={value.scope}>{value.name} = {value.value}</span>)}{preferences.layers.effects ? row.effects.map((effect, i) => <span className="chip gray xs" key={i} data-tip={effect.why}>{effect.glyph} {effect.label}</span>) : null}</div>; }} />{items.length > maxRows ? <p>{zh ? "部分行未显示" : "Additional rows omitted"}</p> : null}</div>; }
  const layers: Array<[ShellVizLayer, string]> = [["color", zh ? "着色" : "Color"], ["inline", zh ? "变量" : "Values"], ["idioms", zh ? "惯用表达" : "Idioms"], ["effects", zh ? "效果" : "Effects"], ["unwrap", zh ? "展开" : "Unwrap"]];
  return <div className="shell-view" ref={host}><button type="button" className="btn small ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{zh ? "执行过程" : "Execution trace"}{preview && marks ? " · Demo" : ""}</button>{open ? <><div className="shell-view-controls"><AppSelect aria-label={zh ? "显示形式" : "View"} value={preferences.view} onChange={event => setPreferences(current => ({ ...current, view: event.target.value as "raw" | "pseudo" }))}><option value="pseudo">Pseudo</option><option value="raw">Raw</option></AppSelect><label><input type="checkbox" checked={preferences.split} onChange={event => setPreferences(current => ({ ...current, split: event.target.checked }))} />{zh ? "分屏" : "Split"}</label>{layers.map(([layer, label]) => <label key={layer}><input type="checkbox" checked={preferences.layers[layer]} onChange={event => setPreferences(current => ({ ...current, layers: { ...current.layers, [layer]: event.target.checked } }))} />{label}</label>)}</div>{error ? <p className="tc-note" role="status">{error}</p> : null}{view ? <><div className={`shell-view-panes${preferences.split ? " split" : ""}`}>{rows(view.rows)}{preferences.split ? rows(view.original) : null}</div><div className="shell-view-controls"><button type="button" className="btn small ghost" onClick={() => setPreferences(current => ({ ...current, cursor: current.cursor ?? 0, playing: !current.playing }))}>{preferences.playing ? zh ? "暂停" : "Pause" : zh ? "回放" : "Replay"}</button><input type="range" aria-label={zh ? "执行时间线" : "Execution timeline"} min={0} max={view.timeline.length} value={preferences.cursor ?? view.timeline.length} onChange={event => setPreferences(current => ({ ...current, cursor: Number(event.target.value), playing: false }))} /><span>{(view.timeline.elapsedNs / 1e9).toFixed(2)} s</span><button type="button" className="btn small ghost" onClick={() => setPreferences(({ cursor: _cursor, ...current }) => ({ ...current, playing: false }))}>{zh ? "最新" : "Latest"}</button></div>{preferences.cursor !== undefined ? <pre className="shell-view-output"><ChunkedText text={view.output} /></pre> : null}{view.timeline.trimmed ? <p className="tc-note">{zh ? "更早的回放记录已截断" : "Earlier replay records were trimmed"}</p> : null}</> : null}</> : null}</div>;
}
