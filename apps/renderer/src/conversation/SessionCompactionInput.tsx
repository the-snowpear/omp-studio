import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatSessionCompactionInput, parseSessionCompactionInput } from "@omp-studio/studio-protocol";
import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import type { CompactionControlState } from "./useSessionCompaction";

export function SessionCompactionInput({ state, loading, saving, error, enabled, onSave }: {
  state: CompactionControlState | undefined; loading: boolean; saving: boolean; error: string; enabled: boolean;
  onSave: (input: string) => Promise<boolean>;
}) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const doc = useSurfaceDocument(), win = surfaceWindow(doc), id = useId();
  const field = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(""), [saved, setSaved] = useState(false);
  const [position, setPosition] = useState<{ left: number; width: number; top?: number | undefined; bottom?: number | undefined }>({ left: 0, bottom: 0, width: 280 });
  const value = formatSessionCompactionInput(state?.threshold ?? null);
  const displayedValue = open ? draft : value;
  const placeholder = loading ? "…" : !state ? "—" : zh ? "默认" : "Default";
  const close = useCallback(() => { setOpen(false); setDraft(value); setSaved(false); }, [value]);
  useEffect(() => { if (!open) setDraft(value); }, [value, open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!field.current?.contains(target) && !panel.current?.contains(target)) { close(); input.current?.blur(); }
    };
    doc.addEventListener("pointerdown", dismiss, true);
    return () => doc.removeEventListener("pointerdown", dismiss, true);
  }, [open, doc, close]);
  useEffect(() => {
    if (!open || !saved) return;
    const timer = win.setTimeout(() => { close(); input.current?.blur(); }, 1200);
    return () => win.clearTimeout(timer);
  }, [open, saved, close, win]);
  useLayoutEffect(() => {
    if (!open || !field.current) return;
    const update = () => {
      const rect = field.current!.getBoundingClientRect();
      const width = Math.min(280, win.innerWidth - 24);
      const height = panel.current?.getBoundingClientRect().height ?? 220;
      const above = rect.top >= height + 20;
      setPosition({ left: Math.max(12, Math.min(rect.left, win.innerWidth - width - 12)), width,
        bottom: above ? win.innerHeight - rect.top + 8 : undefined,
        top: above ? undefined : Math.max(12, Math.min(rect.bottom + 8, win.innerHeight - height - 12)) });
    };
    update(); win.addEventListener("resize", update); doc.addEventListener("scroll", update, true);
    return () => { win.removeEventListener("resize", update); doc.removeEventListener("scroll", update, true); };
  }, [open, doc, win]);
  let parsed = null, invalid = false;
  try { parsed = parseSessionCompactionInput(draft); } catch { invalid = true; }
  const canonical = invalid ? draft : formatSessionCompactionInput(parsed);
  const dirty = canonical !== value;
  const explanation = invalid ? zh ? "输入大于 0、小于 100 的百分比，或 token 数（支持 k / m）。" : "Use a percentage above 0 and below 100, or tokens with k / m."
    : !parsed ? zh ? "恢复继承模型的压缩策略" : "Inherit the model's compaction policy"
    : parsed.kind === "percent" ? zh ? `达到上下文窗口的 ${parsed.value}% 时压缩` : `Compact at ${parsed.value}% of the context window`
    : zh ? `达到 ${parsed.value.toLocaleString()} tokens 时压缩` : `Compact at ${parsed.value.toLocaleString()} tokens`;
  const save = async (text = draft) => {
    if (await onSave(text)) { setDraft(formatSessionCompactionInput(parseSessionCompactionInput(text))); setSaved(true); }
  };
  const blur = (target: EventTarget | null) => {
    if (!field.current?.contains(target as Node) && !panel.current?.contains(target as Node)) close();
  };
  const unavailable = !enabled ? zh ? "连接支持会话阈值的 Runtime 后可设置" : "Connect a Runtime with session threshold support" : loading ? zh ? "读取中…" : "Loading…" : "";
  return <div className={`context-threshold${state?.threshold ? " is-custom" : ""}${open ? " is-open" : ""}`} ref={field}
    onBlur={event => blur(event.relatedTarget)} onPointerDownCapture={() => { if (saved) setSaved(false); }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); input.current?.blur(); } else if (saved) setSaved(false); }}
    data-tip={open ? undefined : unavailable || (zh ? "点击编辑压缩阈值" : "Click to edit the compaction threshold")}>
    <label className="context-threshold-title" htmlFor={id}>{zh ? "阈值" : "Auto"}</label>
    <label className="context-threshold-control" htmlFor={id}>
      <span className="context-threshold-input-wrap">
        <input ref={input} id={id} type="text" aria-label={zh ? "本对话压缩阈值" : "This conversation's compaction threshold"}
          aria-describedby={open ? `${id}-help` : undefined} aria-invalid={open && invalid} aria-controls={open ? `${id}-panel` : undefined}
          value={displayedValue} placeholder={placeholder} readOnly={!enabled || loading || saving}
          spellCheck={false} autoComplete="off" onFocus={() => { if (!open) { setDraft(value); setOpen(true); setSaved(false); } }}
          onChange={event => { setDraft(event.target.value); setSaved(false); }}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (enabled && !loading && !saving && !invalid) { if (dirty) void save(); else { close(); input.current?.blur(); } } } }} />
        <span className="context-threshold-measure" aria-hidden="true">{displayedValue || placeholder}</span>
      </span>
      <Icon name={saved ? "check" : "pencil"} extra={`sm context-threshold-edit${saved ? " is-saved" : ""}`} />
    </label>
    {open ? createPortal(<div ref={panel} id={`${id}-panel`} className="context-threshold-pop" style={position}
      onBlur={event => blur(event.relatedTarget)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); input.current?.blur(); } }}>
      <header><span>{zh ? "本对话的压缩阈值" : "Conversation threshold"}</span><span className="context-threshold-scope">{zh ? "仅此对话" : "This chat"}</span></header>
      <p className="context-threshold-description">{zh ? "随对话保存，重开仍生效。留空恢复默认。" : "Saved with this conversation. Leave blank to inherit defaults."}</p>
      <div className={`context-threshold-result${invalid || error ? " is-error" : ""}`} id={`${id}-help`} role="status">
        <Icon name={invalid || error ? "alert-c" : saved ? "check" : "restore"} extra="sm" />
        <span>{unavailable || error || (saved ? zh ? "已保存到本对话" : "Saved to this conversation" : explanation)}</span>
      </div>
      {!invalid && !dirty && state?.triggerTokens ? <p className="context-threshold-effective">{zh ? "当前实际触发点" : "Current trigger"} <b>{state.triggerTokens.toLocaleString()}</b> tokens</p> : null}
      {!invalid && dirty && parsed?.kind === "tokens" && state?.contextWindow && parsed.value >= state.contextWindow ? <p className="context-threshold-effective">{zh ? "超过当前窗口，实际会按可用上限触发。" : "Above the current window; the effective trigger uses its available budget."}</p> : null}
      {state?.automatic === false ? <p className="context-threshold-effective">{zh ? "自动压缩当前已关闭；阈值会保留。" : "Auto-compaction is off; the threshold is retained."}</p> : null}
      <div className="context-threshold-examples"><span>{zh ? "例如" : "Try"}</span>{["80%", "150k", "0.5m"].map(example => <button key={example} type="button" disabled={!enabled || saving || loading}
        onClick={() => { setDraft(example); setSaved(false); input.current?.focus(); }}>{example}</button>)}</div>
      <footer><button type="button" className="context-threshold-reset" disabled={!enabled || saving || !state?.threshold} onClick={() => void save("")}>{zh ? "恢复默认" : "Reset"}</button>
        <button type="button" className="context-threshold-apply" disabled={!enabled || loading || saving || invalid || !dirty} onClick={() => void save()}>{saving ? zh ? "保存中…" : "Saving…" : zh ? "保存" : "Save"}<kbd>↵</kbd></button></footer>
    </div>, doc.body) : null}
  </div>;
}
