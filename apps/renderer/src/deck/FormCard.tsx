import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Icon } from "../icons";
import { PLATFORM } from "../platform";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { usePreviewMode } from "../preview/PreviewContext";
import { demoMark, PromptHead, QueueNav, type DeckQueue } from "./PromptHead";
import { FormFields, formSectionLabel } from "./FormFields";
import { FormSession, type FormResponder } from "./FormSession";
import { StepNode } from "../conversation/StepRail";
import "./form.css";

/** One Session and the same field DOM survive collapse, section navigation and queue/layout changes. */
export function FormCard({ session, title, summary, meta, demo, queue, disabled, active = true, onRespond }: {
  session: FormSession; title: string; summary: string; meta?: string | undefined; demo?: boolean | undefined;
  queue?: DeckQueue | undefined; disabled?: boolean | undefined; active?: boolean | undefined;
  onRespond: FormResponder;
}) {
  const document = useSurfaceDocument();
  const { marks } = usePreviewMode();
  const view = useSyncExternalStore(session.subscribeView, session.getView, session.getView);
  const loading = useSyncExternalStore(session.subscribeMeta, () => session.getMeta().phase === "loading" && !session.getMeta().error, () => true);
  const root = useRef<HTMLDivElement>(null);
  const surface = useMemo(() => Symbol("form-card"), [session, document]);
  useEffect(() => { session.attach(surface, onRespond, disabled === true, active); return () => session.detach(surface); }, [session, surface]);
  useEffect(() => { session.updateSurface(surface, onRespond, disabled === true, active); }, [session, surface, onRespond, disabled, active]);
  useLayoutEffect(() => {
    if (!active) return;
    const deck = root.current?.closest(".deck");
    deck?.classList.toggle("is-form-expanded", view.expanded);
    return () => deck?.classList.remove("is-form-expanded");
  }, [view.expanded, active]);
  useLayoutEffect(() => {
    if (!active || !view.focusField || view.collapsed) return;
    root.current?.querySelector<HTMLElement>(`[data-form-field-id="${view.focusField}"] [data-form-control]:not([disabled])`)?.focus();
  }, [view.focusVersion, view.collapsed, active]);
  useEffect(() => {
    if (!active || disabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || session.getMeta().phase === "closed") return;
      const isH = event.code ? event.code === "KeyH" : event.key.toLowerCase() === "h";
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isH && !event.repeat && !event.isComposing) {
        event.preventDefault(); session.setCollapsed(!session.getView().collapsed);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [session, active, disabled, document]);
  const form = session.form;
  const sections = form?.sections.flatMap((section, index) => section.blocks.some(block => block.kind === "field") ? [index] : []) ?? [];
  const grouped = Boolean(form && sections.length > 1 && (form.fields.length > 4 || sections.length > 2));
  const current = sections.includes(view.section) ? view.section : sections[0] ?? 0;
  const jump = (index: number) => {
    session.setSection(index);
    const field = form?.sections[index]?.blocks.find(block => block.kind === "field");
    if (field?.kind === "field") session.focusField(field.fieldId);
  };
  return <div ref={root} className="ask-card form-card" onKeyDownCapture={() => session.touch()} onPointerDownCapture={() => session.touch()} onKeyDown={event => {
    if (disabled || !active || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void session.cancel(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void session.submit(); }
  }}>
    <div className="ask-collapsed-bar form-compact" hidden={!view.collapsed}>
      {demoMark(demo, marks)}
      <FormSummary session={session} compact />
      <strong>{summary || title}</strong>
      <QueueNav {...(queue ? { queue } : {})} />
      <button type="button" className="btn small outline" onClick={() => { session.setCollapsed(false); if (form?.fields[0]) session.focusField(form.fields[0].id); }}>展开 / Show</button>
    </div>
    <div className="form-head" hidden={view.collapsed}>
      <PromptHead icon="message" title={title || "Agent 提问"} {...(demo === true ? { demo: true } : {})} {...(meta ? { meta } : {})} {...(queue ? { queue } : {})} chips={<FormSummary session={session} />} end={<span className="form-head-actions">
        <button className="icon-btn small" type="button" aria-label={view.expanded ? "收回表单" : "放大表单"} data-tip={view.expanded ? "收回表单" : "放大表单"} onClick={() => session.setExpanded(!view.expanded)}><Icon name={view.expanded ? "contract" : "expand"} extra="sm" /></button>
        <button className="icon-btn small" type="button" aria-label="收起表单" data-tip={PLATFORM === "darwin" ? "收起 · ⌥H" : "收起 · Alt+H"} onClick={() => session.setCollapsed(true)}><Icon name="minimize" extra="sm" /></button>
      </span>} />
      {grouped && form ? <FormSectionNav session={session} sections={sections} current={current} jump={jump} /> : null}
      <FormProgress session={session} />
    </div>
    <div className="ask-body form-body" hidden={view.collapsed}>
      {loading ? <p className="muted small" role="status">正在读取表单…</p> : form ? <FormFields form={form} session={session} section={current} grouped={grouped} disabled={disabled} /> : null}
    </div>
    <FormError session={session} />
    <FormFooter session={session} disabled={disabled} hidden={view.collapsed} />
  </div>;
}

/** Section stepper: each group shows whether every field in it holds an answer. Re-renders on the filled count only. */
function FormSectionNav({ session, sections, current, jump }: { session: FormSession; sections: number[]; current: number; jump: (index: number) => void }) {
  useSyncExternalStore(session.subscribeMeta, () => session.getMeta().filled, () => 0);
  const form = session.form!;
  const complete = (index: number) => form.sections[index]!.blocks.every(block => block.kind !== "field" || session.isFieldFilled(block.fieldId));
  return <nav className="form-section-nav" aria-label="表单题组" onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const pos = sections.indexOf(current);
    const index = event.key === "Home" ? sections[0] : event.key === "End" ? sections.at(-1) : sections[Math.max(0, Math.min(sections.length - 1, pos + (event.key === "ArrowLeft" ? -1 : 1)))];
    if (index !== undefined) jump(index);
  }}>{sections.map((index, at) => {
    const done = complete(index);
    return <button key={index} type="button" className={`form-step${index === current ? " active" : ""}${done ? " is-done" : ""}`} aria-current={index === current ? "step" : undefined} onClick={() => jump(index)}>
      <StepNode tone={index === current ? "active" : done ? "done" : "pending"} label={at + 1} /><span className="sr-only">{at + 1}</span><span className="form-step-label">{formSectionLabel(form, index)}</span>
    </button>;
  })}</nav>;
}

/** A thin bar under the head: answered fields over all fields, as the native form reports them. */
function FormProgress({ session }: { session: FormSession }) {
  const { filled, total } = useSyncExternalStore(session.subscribeMeta, session.getMeta, session.getMeta);
  if (!total) return null;
  return <span className="form-progress" aria-hidden><i style={{ width: `${Math.min(100, (filled / total) * 100)}%` }} /></span>;
}

/** Countdown and filled count update only this leaf, never the input subtree or conversation. */
function FormSummary({ session, compact }: { session: FormSession; compact?: boolean | undefined }) {
  const state = useSyncExternalStore(session.subscribeMeta, session.getMeta, session.getMeta);
  return <span className={`form-summary${compact ? " is-compact" : ""}`}>
    <span>{state.filled}/{state.total} 已填</span>
    {state.remaining === undefined ? null : <span className="form-countdown" data-tip="输入会重置闲置倒计时；超时提交当前值"><Icon name="clock" extra="sm" />{state.remaining}s</span>}
    {state.phase === "submitting" ? <span role="status">{state.timedOut ? "超时提交当前值…" : "提交中…"}</span> : state.timedOut && !state.error && state.phase === "open" ? <span role="status">闲置超时，等待连接后提交当前值</span> : null}
  </span>;
}
function FormError({ session }: { session: FormSession }) {
  const state = useSyncExternalStore(session.subscribeMeta, session.getMeta, session.getMeta);
  return state.error ? <div className="ask-error"><p role="alert">{state.error}</p>{state.phase === "loading" ? <button type="button" className="btn small outline" onClick={() => session.retryRead()}>重试读取</button> : null}</div> : null;
}
function FormFooter({ session, disabled, hidden }: { session: FormSession; disabled?: boolean | undefined; hidden: boolean }) {
  const phase = useSyncExternalStore(session.subscribeMeta, () => session.getMeta().phase, () => "loading" as const);
  const locked = disabled || phase === "submitting" || phase === "closed";
  return <div className="dk-actions" hidden={hidden}>
    <button type="button" className="btn lg outline" disabled={locked} onClick={() => { void session.cancel(); }}>取消</button>
    <button type="button" className="btn lg primary" disabled={locked || phase === "loading"} onClick={() => { void session.submit(); }}>提交</button>
  </div>;
}
